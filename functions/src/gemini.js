'use strict';
/**
 * gemini.js — transcribe a YouTube video with the Gemini API (fallback
 * caption source when the Innertube player endpoint is bot-checked).
 *
 * Why this exists (2026-11-12): from Google Cloud Functions egress IPs,
 * YouTube returns LOGIN_REQUIRED ("sign in to confirm you're not a bot")
 * for ALL Innertube clients (ANDROID/IOS/WEB/TVHTML5 — verified live with
 * per-client diagnostics). The Gemini API accepts a YouTube URL directly
 * (fileData) and transcribes the audio itself, so no scraping is involved
 * and videos WITHOUT any caption track work too (Miraa-style).
 *
 * Verified 2026-11-12 (free-tier key, gemini-3-flash-preview): the sample
 * Shorts mKPRQF70PvA returned 21 timestamped lines; against the known
 * 23-sentence corrected transcript every sentence was present (diffs only
 * in segmentation, fillers and kana/kanji rendering — 0 invented lines,
 * 0 dropped sentences). Timestamps carry one decimal place (prompt asks
 * for it explicitly since 2026-11-13). ~8,300 tokens for a 1-minute video.
 *
 * 2026-11-13: transcribeWithGemini also returns `lines` (its own
 * per-sentence segmentation) — the pipeline prefers them over parseJson3,
 * which would merge the sentences into ~12s lines. generateNotes() adds a
 * short Vietnamese explanation per line (tap-to-explain in the app);
 * it is non-fatal (lesson builds without notes on any failure).
 *
 * Caveats:
 * - Free-tier Flash models 503 ("high demand") often (3/4 attempts on
 *   2026-11-12). The caller retries across GEMINI_MODELS in order; a paid
 *   tier / Vertex AI is more reliable. 503/429 surface as GEMINI_OVERLOADED
 *   so the caller can report "AI quá tải, thử lại sau" instead of blaming
 *   the video. generateNotes fails FAST on a dead tier (30s/attempt, quota
 *   error or an all-models-failed chunk stops the phase) so a lesson never
 *   waits ~9 min for notes that come back empty anyway (2026-11-13).
 * - The API key comes from the GEMINI_API_KEY Firebase secret (see
 *   DEPLOY.md). Without it this module is skipped entirely (callers fall
 *   back to the original Innertube error).
 */

const { CaptionError } = require('./captions');

// Proven working first; the -latest alias and 3.8-flash are fallbacks.
const GEMINI_MODELS = ['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.8-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PER_ATTEMPT_TIMEOUT_MS = 180000;
// Notes are generated in small chunks: asking for 40+ notes in one call
// makes the model miscount/truncate the JSON array, and the old code threw
// the WHOLE lesson's notes away on any length mismatch — Marigold (42 lines)
// got 0/42 twice on 2026-11-13 while an 11-line lesson got 9/11.
const NOTES_CHUNK_SIZE = 12;

const TRANSCRIBE_PROMPT =
  'Transcribe this Japanese video. Return ONLY a JSON array of objects, each with ' +
  '"start" (seconds, number with one decimal place, e.g. 12.5), "end" (seconds, ' +
  'number with one decimal place) and "jp" (the exact Japanese sentence spoken ' +
  'in that time span). One object per spoken sentence, in order. Split long ' +
  'utterances into short sentences at natural pauses (each object SHOULD cover ' +
  'at most ~6 seconds); never merge several sentences into one object. ' +
  'Do not translate. Do not add any commentary or markdown.';

const NOTES_PROMPT =
  'Bạn là giáo viên tiếng Nhật cho người Việt. Với mỗi câu tiếng Nhật dưới đây, ' +
  'viết 1 ghi chú giải thích ngắn bằng tiếng Việt: từ khó/cụm từ đáng học + ' +
  'điểm ngữ pháp chính trong câu (nếu có), tối đa 2 dòng, không dịch lại cả câu. ' +
  'Câu quá đơn giản thì ghi chú là chuỗi rỗng. Trả về ĐÚNG 1 JSON array các ' +
  'chuỗi, đúng thứ tự các câu, đủ số phần tử. Không thêm bình luận hay markdown.';

function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithModel(videoId, model, apiKey) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                fileData: {
                  mimeType: 'video/mp4',
                  fileUri: `https://www.youtube.com/watch?v=${videoId}`,
                },
              },
              { text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    },
    PER_ATTEMPT_TIMEOUT_MS
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data && data.error ? data.error.code : res.status;
    const msg = data && data.error ? data.error.message : `HTTP ${res.status}`;
    if (res.status === 429 || res.status === 503) {
      throw new CaptionError('GEMINI_OVERLOADED', `Gemini quá tải (${model}): ${msg}`);
    }
    throw new CaptionError('GEMINI_FAILED', `Gemini lỗi (${model}, ${code}): ${String(msg).slice(0, 200)}`);
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
  let lines;
  try {
    lines = JSON.parse(text);
  } catch (err) {
    throw new CaptionError('GEMINI_FAILED', `Gemini trả về kết quả không phải JSON (${model}).`);
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new CaptionError('GEMINI_FAILED', `Gemini không nghe được câu nào trong video này (${model}).`);
  }
  const clean = lines
    .filter(
      (l) =>
        l && typeof l.jp === 'string' && l.jp.trim() && Number.isFinite(l.start) && Number.isFinite(l.end)
    )
    .map((l) => ({ start: Number(l.start), end: Math.max(Number(l.start), Number(l.end)), jp: l.jp.trim() }));
  if (clean.length === 0) {
    throw new CaptionError('GEMINI_FAILED', `Gemini trả về câu rỗng, không dùng được (${model}).`);
  }
  return clean;
}

/**
 * Generate a short Vietnamese explanation note per Japanese line
 * (hard words + main grammar point). Text-only call — cheap and fast.
 * NON-FATAL by design: returns null on missing key, overload or any
 * failure; the caller then builds the lesson without notes.
 * @param {string[]} jpTexts
 * @returns {Promise<(string|null)[]|null>} notes in order, or null
 */
async function generateNotesWithModel(jpTexts, model, apiKey) {
  const numbered = jpTexts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${NOTES_PROMPT}\n\n${numbered}` }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    },
    30000 // notes are short text calls: healthy ones return in seconds; a
    // hung call must not burn 120s (a real lesson on 2026-11-13 lost ~9 min
    // to 3 models x N chunks timing out one by one).
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error.message : `HTTP ${res.status}`;
    const err = new Error(`Gemini notes lỗi (${model}): ${String(msg).slice(0, 150)}`);
    // 429 quota is per-project (all models share it); 503 overload is per-model.
    if (res.status === 429) err.code = 'GEMINI_QUOTA';
    else if (res.status === 503) err.code = 'GEMINI_OVERLOADED';
    throw err;
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
  const notes = JSON.parse(text);
  if (!Array.isArray(notes)) {
    throw new Error(`Gemini notes trả về không phải mảng cho ${jpTexts.length} câu.`);
  }
  // Length mismatch must not wipe the chunk: the model usually keeps order
  // and loses the tail, so pad the tail with '' / drop the extras.
  if (notes.length !== jpTexts.length) {
    console.warn(`[gemini] notes count mismatch: got ${notes.length} for ${jpTexts.length}, padding/truncating`);
  }
  const out = [];
  for (let i = 0; i < jpTexts.length; i += 1) {
    out.push(typeof notes[i] === 'string' ? notes[i].trim() : '');
  }
  return out;
}

async function generateNotes(jpTexts) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || !Array.isArray(jpTexts) || jpTexts.length === 0) return null;
  const all = [];
  // Fail-fast (2026-11-13): when the free tier is down, every model fails
  // the same way — cycling 3 models x N chunks burned ~9 min on a real
  // lesson (17:50 JST) for notes that ended up empty anyway. Notes are
  // non-fatal, so stop at the first sign the tier is down: a 429 quota
  // error (per-project, no model can dodge it) ends the whole phase at
  // once, and a chunk that fails on every model trips a circuit breaker
  // for the remaining chunks. Worst case is now ~1 chunk of attempts
  // (~95s) instead of ~3.5 min per chunk.
  for (let start = 0; start < jpTexts.length; start += NOTES_CHUNK_SIZE) {
    const chunk = jpTexts.slice(start, start + NOTES_CHUNK_SIZE);
    let notes = null;
    let anyModelOk = false;
    let quotaHit = false;
    for (let i = 0; i < GEMINI_MODELS.length; i += 1) {
      try {
        notes = await generateNotesWithModel(chunk, GEMINI_MODELS[i], apiKey);
        anyModelOk = true;
        break;
      } catch (err) {
        console.warn('[gemini] generateNotes failed on', GEMINI_MODELS[i], '-', err.message);
        if (err && err.code === 'GEMINI_QUOTA') {
          quotaHit = true;
          break;
        }
        if (i < GEMINI_MODELS.length - 1) await sleep(2000);
      }
    }
    // A failed chunk must not wipe the other chunks' notes.
    if (!notes) notes = chunk.map(() => '');
    all.push(...notes);
    if (quotaHit || !anyModelOk) {
      // Tier is down: fill the remaining chunks without further calls.
      const remaining = jpTexts.length - (start + chunk.length);
      for (let k = 0; k < remaining; k += 1) all.push('');
      break;
    }
  }
  return all;
}

async function fetchTitle(videoId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`,
      { method: 'GET' },
      10000
    );
    if (!res.ok) return '';
    const data = await res.json().catch(() => ({}));
    return typeof data.title === 'string' ? data.title : '';
  } catch (err) {
    return '';
  }
}

/**
 * Transcribe a video with Gemini. Returns the same shape as
 * fetchJapaneseCaptions: { title, durationSec, source: 'gemini', json3 },
 * PLUS `lines` — Gemini's own per-sentence lines. Callers MUST prefer
 * `lines`: parseJson3() is designed for tiny auto-sub fragments and would
 * MERGE Gemini's sentences (they often end with 、 not 。) into ~12s lines,
 * which breaks karaoke timing. The json3 is kept as a fallback so the
 * existing parse path still works if `lines` is ever absent.
 * @throws {CaptionError} GEMINI_NO_KEY | GEMINI_OVERLOADED | GEMINI_FAILED
 */
async function transcribeWithGemini(videoId) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new CaptionError('GEMINI_NO_KEY', 'Chưa cấu hình GEMINI_API_KEY.');
  }
  let lastOverloaded = null;
  for (let i = 0; i < GEMINI_MODELS.length; i += 1) {
    const model = GEMINI_MODELS[i];
    try {
      const lines = await transcribeWithModel(videoId, model, apiKey);
      const title = await fetchTitle(videoId);
      const json3 = {
        events: lines.map((l) => ({
          tStartMs: Math.round(l.start * 1000),
          dDurationMs: Math.max(100, Math.round((l.end - l.start) * 1000)),
          segs: [{ utf8: l.jp }],
        })),
      };
      return {
        title,
        durationSec: lines.length > 0 ? lines[lines.length - 1].end : null,
        source: 'gemini',
        json3,
        lines,
      };
    } catch (err) {
      if (err instanceof CaptionError && err.code === 'GEMINI_OVERLOADED') {
        lastOverloaded = err;
        if (i < GEMINI_MODELS.length - 1) {
          await sleep(2000);
          continue;
        }
        throw lastOverloaded;
      }
      throw err;
    }
  }
  throw lastOverloaded || new CaptionError('GEMINI_FAILED', 'Gemini không trả về kết quả.');
}

module.exports = { transcribeWithGemini, generateNotes, hasGeminiKey, fetchTitle, GEMINI_MODELS };
