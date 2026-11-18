'use strict';
/**
 * Captions.js — fetch a video's Japanese caption track from YouTube, server-side.
 *
 * PRIMARY PATH (no API key, no login): YouTube Innertube `player` endpoint.
 * Tries several clients in order — ANDROID first, then IOS, WEB, TVHTML5.
 * NOTE (2026-11-12): from a dev-machine IP ANDROID returns OK, but from
 * Google Cloud Functions egress IPs ALL FOUR clients return LOGIN_REQUIRED
 * (bot-check) — verified live with per-client diagnostics. So on the
 * deployed function the primary path always fails and the GEMINI FALLBACK
 * below is the path that actually serves lessons.
 *
 * GEMINI FALLBACK (src/gemini.js, needs the GEMINI_API_KEY secret): when
 * the player is bot-checked or the video has no Japanese track, transcribe
 * the audio with the Gemini API (it takes a YouTube URL directly). Works
 * for videos without any captions. See gemini.js for verification notes.
 *
 * Why not the browser: the app (static PWA) cannot call these endpoints
 * directly — YouTube answers cross-origin browser requests with CORS errors
 * and bot-checks. From Google Cloud Functions the same requests go out from
 * Google's own network, which is how the well-known `youtube-transcript`
 * libraries work.
 *
 * Track selection: Japanese only. A manually-uploaded Japanese track is
 * preferred over auto-generated Japanese (kind === 'asr'), because auto
 * subtitles contain recognition errors (measured: ~4 errors / 1 minute on
 * the test Shorts) and must never be taught as-is.
 *
 * FALLBACK PATH (env-gated, off by default): yt-dlp, if a binary is present
 * at YTDLP_PATH. Used for local/manual runs only — NOT bundled in the
 * deployed function (40 MB binary, and YouTube actively bot-checks datacenter
 * IPs; see README).
 */

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // public WEB client key, same one the YouTube website uses
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`;

class CaptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaptionError';
    this.code = code; // VIDEO_UNAVAILABLE | NO_CAPTIONS | FETCH_FAILED
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new CaptionError('FETCH_FAILED', `YouTube trả về HTTP ${res.status} khi gọi ${url.split('?')[0]}.`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof CaptionError) throw err;
    if (err.name === 'AbortError') {
      throw new CaptionError('FETCH_FAILED', 'Hết thời gian chờ khi gọi YouTube (15 giây).');
    }
    throw new CaptionError('FETCH_FAILED', `Không gọi được YouTube: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Innertube clients to try, in order. ANDROID first: it is not bot-checked
 * from datacenter IPs the way WEB/TV are (verified 2026-11-12). */
const INNERTUBE_CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
  { clientName: 'IOS', clientVersion: '20.10.38', deviceModel: 'iPhone16,2' },
  { clientName: 'WEB', clientVersion: '2.20250728.00.00', clientScreen: 'WATCH' },
  { clientName: 'TVHTML5', clientVersion: '7.20250212.00.00' },
];

/** Call the Innertube player endpoint with one client and return the raw player response. */
async function fetchPlayerWithClient(videoId, client) {
  const body = {
    context: {
      client: {
        ...client,
        hl: 'ja',
        gl: 'JP',
        timeZone: 'Asia/Tokyo',
      },
      request: { useSsl: true },
      user: { lockedSafetyMode: false },
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        autoplay: true,
        html5Preference: 'HTML5_PREF_WANTS',
        lactMilliseconds: '-1',
      },
    },
    racyCheckOk: true,
    contentCheckOk: true,
  };
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Origin: 'https://www.youtube.com',
  };
  // One retry on transient network failure.
  try {
    return await fetchJson(INNERTUBE_PLAYER_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    await sleep(800);
    return await fetchJson(INNERTUBE_PLAYER_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  }
}

/**
 * Call the Innertube player endpoint, trying each client in turn until one
 * returns a playable response. Returns the first response with
 * playabilityStatus OK (or LIVE_STREAM_OFFLINE); if none is playable,
 * returns the last response so the caller can report its reason.
 */
async function fetchPlayerResponse(videoId) {
  let last = null;
  const tried = [];
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const res = await fetchPlayerWithClient(videoId, client);
      last = res;
      const status = res && res.playabilityStatus ? res.playabilityStatus.status : null;
      tried.push(`${client.clientName}=${status || 'NO_STATUS'}`);
      if (status === 'OK' || status === 'LIVE_STREAM_OFFLINE') {
        res._tried = tried;
        return res;
      }
    } catch (err) {
      // Network/fetch failure for this client — try the next one.
      tried.push(`${client.clientName}=FETCH_FAIL`);
    }
  }
  if (last) {
    last._tried = tried;
    return last;
  }
  throw new CaptionError('FETCH_FAILED', `Không gọi được YouTube bằng bất kỳ client nào. [thử: ${tried.join(', ')}]`);
}

/**
 * Pick the best Japanese track from a captionTracks array.
 * Returns null when there is no Japanese track.
 *   { languageCode, name, kind ('asr' = auto-generated, undefined = manual),
 *     baseUrl, source: 'manual' | 'auto' }
 */
function pickJapaneseTrack(captionTracks) {
  if (!Array.isArray(captionTracks)) return null;
  const ja = captionTracks.filter(
    (t) => t && typeof t.baseUrl === 'string' && (t.languageCode === 'ja' || t.languageCode === 'ja-Hrkt')
  );
  if (ja.length === 0) return null;
  const manual = ja.find((t) => t.kind !== 'asr');
  const chosen = manual || ja[0];
  return {
    languageCode: chosen.languageCode,
    name: chosen.name && chosen.name.simpleText ? chosen.name.simpleText : chosen.languageCode,
    kind: chosen.kind || 'manual',
    baseUrl: chosen.baseUrl,
    source: chosen.kind === 'asr' ? 'auto' : 'manual',
  };
}

/** Fetch a caption track's timedtext as JSON3 (events with tStartMs + segs). */
async function fetchJson3(track) {
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  const data = await fetchJson(u.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  });
  if (!data || !Array.isArray(data.events)) {
    throw new CaptionError('FETCH_FAILED', 'YouTube trả về phụ đề rỗng hoặc sai định dạng.');
  }
  return data;
}

/**
 * Optional yt-dlp fallback (local/manual runs only).
 * Requires YTDLP_PATH env var pointing at a yt-dlp binary.
 * Returns { source, json3 } or null when yt-dlp is not configured / fails.
 */
async function fetchWithYtDlp(videoId) {
  const ytdlp = process.env.YTDLP_PATH;
  if (!ytdlp) return null;
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const run = promisify(execFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sorakanji-subs-'));
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await run(ytdlp, [
      '--skip-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs',
      'ja',
      '--sub-format',
      'json3',
      '--output',
      path.join(tmp, '%(id)s'),
      url,
    ], { timeout: 60000 });
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.json3'));
    if (files.length === 0) return null;
    // Prefer a manual track (no ".auto." in the name) over an auto one.
    files.sort((a, b) => (a.includes('.auto.') ? 1 : 0) - (b.includes('.auto.') ? 1 : 0));
    const data = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), 'utf8'));
    return {
      source: files[0].includes('.auto.') ? 'auto' : 'manual',
      json3: data,
      trackName: files[0],
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Gemini fallback (src/gemini.js): when the Innertube path fails — either
 * the player is bot-checked (all clients LOGIN_REQUIRED from Google Cloud
 * egress IPs, verified 2026-11-12) or the video has no Japanese track —
 * transcribe the audio with Gemini instead. Returns the Gemini result on
 * success; otherwise rethrows the ORIGINAL error (the video really is
 * unavailable / captionless — Gemini failing does not change that).
 * Gemini overload (503/429) is reported as its own error so the user knows
 * the video is fine and only needs to retry in a few minutes.
 * The require() is lazy to avoid a require cycle (gemini.js imports
 * CaptionError from this module).
 */
async function tryGeminiOrThrow(videoId, originalError) {
  const { transcribeWithGemini, hasGeminiKey } = require('./gemini');
  if (!hasGeminiKey()) throw originalError;
  try {
    return await transcribeWithGemini(videoId);
  } catch (err) {
    if (err instanceof CaptionError && err.code === 'GEMINI_OVERLOADED') {
      throw new CaptionError(
        'FETCH_FAILED',
        'Máy chủ AI (Gemini) đang quá tải, thử lại sau ít phút. (YouTube cũng đang chặn máy chủ lấy phụ đề trực tiếp.)'
      );
    }
    // eslint-disable-next-line no-console
    console.warn(`[captions] Gemini fallback failed for ${videoId}:`, err && err.message);
    throw originalError;
  }
}

/**
 * Main entry: fetch the best Japanese caption track for a video.
 * Returns { title, durationSec, source: 'manual'|'auto'|'gemini', json3 }.
 * Throws CaptionError('VIDEO_UNAVAILABLE' | 'NO_CAPTIONS' | 'FETCH_FAILED').
 */
async function fetchJapaneseCaptions(videoId, opts = {}) {
  const getPlayer = opts.fetchPlayerResponse || fetchPlayerResponse;
  const player = await getPlayer(videoId);

  const status = player && player.playabilityStatus ? player.playabilityStatus.status : null;
  if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
    const reason = player.playabilityStatus.reason || '';
    const tried = Array.isArray(player._tried) && player._tried.length > 0
      ? ` [thử: ${player._tried.join(', ')}]`
      : '';
    return tryGeminiOrThrow(
      videoId,
      new CaptionError(
        'VIDEO_UNAVAILABLE',
        `Video này không phát được (${reason || status}). Kiểm tra lại link — có thể video đã bị xóa, riêng tư hoặc giới hạn độ tuổi.${tried}`
      )
    );
  }

  const title =
    (player.videoDetails && player.videoDetails.title) || '';
  const durationSec =
    player.videoDetails && player.videoDetails.lengthSeconds
      ? Number(player.videoDetails.lengthSeconds)
      : null;

  const tracks =
    player.captions &&
    player.captions.playerCaptionsTracklistRenderer &&
    player.captions.playerCaptionsTracklistRenderer.captionTracks;
  const track = pickJapaneseTrack(tracks);

  if (!track) {
    // No Japanese track in the player response — try yt-dlp before giving up.
    const viaYtdlp = await fetchWithYtDlp(videoId);
    if (viaYtdlp) return { title, durationSec, source: viaYtdlp.source, json3: viaYtdlp.json3 };
    return tryGeminiOrThrow(
      videoId,
      new CaptionError(
        'NO_CAPTIONS',
        'Video này không có phụ đề tiếng Nhật (cả phụ đề do người đăng tải lên lẫn phụ đề tự động), và AI cũng không nghe được lời thoại. Thử video khác.'
      )
    );
  }

  const json3 = await fetchJson3(track);
  return { title, durationSec, source: track.source, json3 };
}

module.exports = {
  fetchJapaneseCaptions,
  fetchPlayerResponse,
  pickJapaneseTrack,
  fetchJson3,
  fetchWithYtDlp,
  CaptionError,
};
