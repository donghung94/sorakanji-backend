'use strict';
/**
 * pipeline.js — orchestration: URL -> lesson JSON.
 *
 * Steps:
 *   1. extractVideoId
 *   2. fetchJapaneseCaptions  (Innertube -> captionTracks -> timedtext json3;
 *      on bot-check / no captions, falls back to Gemini transcription —
 *      see src/gemini.js; needs the GEMINI_API_KEY secret)
 *   3. parseJson3              (fragments -> sentence-like lines, RAW text kept)
 *   4. translateTexts         (ja -> vi, machine translation, viAuto: true)
 *   5. annotateLines          (kuromoji furigana + romaji)
 *
 * Translation failure is NON-FATAL: the lesson is still returned with
 * vi: null and meta.translationAvailable === false, so the app can show
 * "chưa có bản dịch — bấm thử lại" instead of losing the whole lesson.
 * Caption failure IS fatal: inventing subtitles for a video that has none
 * is never acceptable — the error message (Vietnamese) is returned instead.
 *
 * Notes (per-line explanations) are OFF by user decision 2026-11-13 —
 * see NOTES_ENABLED below. Gemini listening (step 2 fallback) stays on.
 */

const { extractVideoId } = require('./videoId');
const { fetchJapaneseCaptions, CaptionError } = require('./captions');
const { parseJson3 } = require('./parse');
const { translateTexts, TranslateError } = require('./translate');
const { translateTextsFree } = require('./translate-free');
const { annotateLines } = require('./furigana');
const { generateNotes, fetchTitle } = require('./gemini');
const { getCachedLesson, putCachedLesson } = require('./lesson-cache');

// 2026-11-13 (user decision): per-line explanation notes are OFF. The
// Gemini free tier is quota-exhausted/overloaded, and notes were the only
// Gemini step left for captioned videos (device captions replaced Gemini
// listening; translation is Cloud Translation; furigana is local
// kuromoji). Skipping notes makes lesson creation fast and Gemini-free
// for captioned videos. Gemini LISTENING (transcribeWithGemini, used only
// when a video has no caption track at all) stays enabled per the same
// decision. generateNotes() is kept in src/gemini.js (tested, fail-fast)
// — set NOTES_ENABLED = true to turn explanations back on once Gemini
// billing is enabled.
const NOTES_ENABLED = false;

/**
 * InputError — bad client input (maps to HttpsError 'invalid-argument',
 * HTTP 400, in index.js). Used for the client-supplied captions path.
 */
class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Validate client-supplied captions (json3 from the native app, which
 * fetches the caption track on the user's phone). Strict: the object must
 * be a json3 document with a non-empty events array. Returns the captions
 * unchanged when valid; throws InputError otherwise. Malformed events
 * inside a structurally valid document are caught later by parseJson3
 * (0 lines -> NO_CAPTIONS).
 */
const MAX_CAPTION_EVENTS = 100000;
function validateClientCaptions(captions) {
  if (!captions || typeof captions !== 'object' || Array.isArray(captions)) {
    throw new InputError('Phụ đề gửi kèm không hợp lệ (cần object json3).');
  }
  if (!Array.isArray(captions.events) || captions.events.length === 0) {
    throw new InputError('Phụ đề gửi kèm rỗng (không có events).');
  }
  if (captions.events.length > MAX_CAPTION_EVENTS) {
    throw new InputError('Phụ đề gửi kèm quá dài.');
  }
  if (typeof captions.events[0] !== 'object' || captions.events[0] === null) {
    throw new InputError('Phụ đề gửi kèm sai định dạng (events không phải object).');
  }
  return captions;
}

/**
 * Translator contract (both paths return the same shape):
 *   async (jpTexts: string[]) =>
 *     { translations: (string|null)[], status: 'ok'|'partial'|'unavailable', error: string|null }
 *
 * Paid path: Cloud Translation API (src/translate.js). Its translateTexts
 * throws on failure and has a skip mode — the adapter below normalises it
 * to the contract. Free path: src/translate-free.js, never throws for
 * translation failure (it reports per-chunk status instead).
 */
async function paidTranslator(texts) {
  const { translations, skipped } = await translateTexts(texts);
  if (skipped) {
    return {
      translations,
      status: 'unavailable',
      error: 'Bỏ qua bước dịch máy (--no-translate): dịch tay sau.',
    };
  }
  return { translations, status: 'ok', error: null };
}

async function freeTranslator(texts) {
  return translateTextsFree(texts);
}

/**
 * Build a lesson JSON from already-fetched caption data.
 * Pure pipeline (no network) — used by buildLesson() and by the local
 * test harness with fixture JSON3.
 * @param {{ videoId: string, title: string, durationSec: number|null, source: 'manual'|'auto'|'gemini', json3: Object }} fetched
 * @param {{ translate?: Function }} opts — translator override; default is the paid one.
 */
async function buildLessonFromFetched(fetched, opts = {}) {
  const translate = opts.translate || paidTranslator;
  const { videoId, title, durationSec, source, json3 } = fetched;
  // Gemini already returns sentence-level lines — use them directly.
  // parseJson3() is only for caption fragments (it would merge Gemini's
  // sentences into ~12s lines because they often end with 、 not 。).
  const lines =
    Array.isArray(fetched.lines) && fetched.lines.length > 0
      ? fetched.lines.map((l) => ({ start: l.start, end: l.end, jp: l.jp }))
      : parseJson3(json3);
  if (lines.length === 0) {
    throw new CaptionError(
      'NO_CAPTIONS',
      'Phụ đề của video này rỗng — không lấy được câu nào. Thử video khác.'
    );
  }

  // 4. Translate (non-fatal on failure).
  let translationStatus = 'ok';
  let translationError = null;
  let viList = lines.map(() => null);
  try {
    const res = await translate(lines.map((l) => l.jp));
    viList = res.translations;
    translationStatus = res.status || 'ok';
    translationError = res.error || null;
  } catch (err) {
    translationStatus = 'unavailable';
    translationError = err instanceof TranslateError ? err.message : String(err);
  }
  const translationAvailable = translationStatus !== 'unavailable';

  // 5. Furigana + romaji (local kuromoji). Per-line explanation notes are
  // OFF by user decision 2026-11-13 (NOTES_ENABLED above) — new lessons
  // carry notes: null; tap-to-explain shows nothing for them.
  const [annotated, notes] = await Promise.all([
    annotateLines(lines),
    NOTES_ENABLED ? generateNotes(lines.map((l) => l.jp)) : Promise.resolve(null),
  ]);

  const warnings = [];
  if (source === 'auto') {
    warnings.push(
      'Phụ đề tự động của YouTube — đã ghi nhận có lỗi nhận dạng (vd video test có ~4 lỗi/1 phút). Cần người soát lại từng câu trước khi dạy.'
    );
  }
  if (source === 'gemini') {
    warnings.push(
      'Lời thoại và ghi chú giải thích do AI (Gemini) tạo ra — có thể sai vài chỗ và mốc thời gian có thể lệch vài phần giây. Cần người soát lại từng câu trước khi dạy.'
    );
  }
  if (!translationAvailable) {
    warnings.push(`Chưa dịch được sang tiếng Việt: ${translationError}`);
  }
  for (const a of annotated) {
    if (a.furiganaWarning) warnings.push(a.furiganaWarning);
  }

  return {
    videoId,
    title,
    durationSec,
    source, // 'manual' | 'auto'
    lines: annotated.map((l, i) => ({
      start: round2(l.start),
      end: round2(l.end),
      jp: l.jp,
      reading: l.reading,
      romaji: l.romaji,
      vi: viList[i],
      viAuto: true,
      notes: notes && typeof notes[i] === 'string' && notes[i] ? notes[i] : null,
      tokens: l.tokens || null,
    })),
    meta: {
      lineCount: annotated.length,
      translationAvailable,
      translationStatus, // 'ok' | 'partial' | 'unavailable' — app shows the badge / retry hint from this
      translationError,
      warnings: [...new Set(warnings)],
    },
  };
}

function resolveVideoId(input) {
  const raw = (input && (input.videoId || input.url)) || '';
  return extractVideoId(String(raw));
}

/**
 * Cache wrapper shared by buildLesson / buildLessonFree: return the stored
 * lesson when this video was already built (instant, $0), otherwise build
 * and store it (only full lessons — translationStatus 'ok' — are cached,
 * so a vi-less build never poisons the cache). Cache failures are
 * non-fatal: any error falls back to building. input.refresh skips the
 * cache read (admin rebuild path).
 */
async function buildWithCache(input, buildFn) {
  const videoId = resolveVideoId(input);
  if (!input || !input.refresh) {
    const cached = await getCachedLesson(videoId);
    if (cached) {
      return { ...cached, meta: { ...(cached.meta || {}), fromCache: true } };
    }
  }
  const lesson = await buildFn(videoId);
  if (lesson && lesson.meta && lesson.meta.translationStatus === 'ok') {
    await putCachedLesson(videoId, lesson);
  }
  return lesson;
}

/**
 * Build a lesson JSON from a YouTube URL or video ID.
 *
 * Client-captions path (native app): when input.captions is present, the
 * client already fetched the caption track on the user's phone (native
 * HTTP, residential IP — YouTube does not bot-check it the way it blocks
 * Google Cloud egress IPs). The server then SKIPS fetchJapaneseCaptions
 * and Gemini entirely and runs the same pipeline (parse -> translate ->
 * furigana -> notes -> cache) on the supplied json3. Title comes from
 * input.title when the client sends it, otherwise from oEmbed.
 * Invalid captions throw InputError (HTTP 400) before any cache lookup.
 * @param {{ url?: string, videoId?: string, refresh?: boolean, captions?: Object, title?: string, captionSource?: string }} input
 * @returns {Promise<Object>} lesson JSON (see README for the schema)
 * @throws {VideoIdError|CaptionError|InputError} on invalid input / no captions
 */
async function buildLesson(input) {
  const clientCaptions = input && input.captions ? validateClientCaptions(input.captions) : null;
  return buildWithCache(input, async (videoId) => {
    if (clientCaptions) {
      const title = (input.title && String(input.title).trim()) || (await fetchTitle(videoId));
      const source = input.captionSource === 'manual' ? 'manual' : 'auto';
      return buildLessonFromFetched({ videoId, title, durationSec: null, source, json3: clientCaptions });
    }
    const fetched = await fetchJapaneseCaptions(videoId);
    return buildLessonFromFetched({ videoId, ...fetched });
  });
}

/**
 * FREE variant of buildLesson: same pipeline, but translation goes through
 * the unofficial free Google Translate endpoint (src/translate-free.js)
 * instead of the paid Cloud Translation API. Translation failure is
 * non-fatal: the lesson still returns with vi: null on the untranslated
 * lines and meta.translationStatus 'partial' / 'unavailable'.
 * @param {{ url?: string, videoId?: string, refresh?: boolean }} input
 * @returns {Promise<Object>} lesson JSON (same schema as buildLesson)
 * @throws {VideoIdError|CaptionError} on invalid input / no captions
 */
async function buildLessonFree(input) {
  return buildWithCache(input, async (videoId) => {
    const fetched = await fetchJapaneseCaptions(videoId);
    return buildLessonFromFetched({ videoId, ...fetched }, { translate: freeTranslator });
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildLesson, buildLessonFree, buildLessonFromFetched, InputError };
