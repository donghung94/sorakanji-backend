'use strict';
/**
 * pipeline.js — orchestration: URL -> lesson JSON.
 *
 * Steps:
 *   1. extractVideoId
 *   2. fetchJapaneseCaptions  (Innertube -> captionTracks -> timedtext json3)
 *   3. parseJson3              (fragments -> sentence-like lines, RAW text kept)
 *   4. translateTexts         (ja -> vi, machine translation, viAuto: true)
 *   5. annotateLines          (kuromoji furigana + romaji)
 *
 * Translation failure is NON-FATAL: the lesson is still returned with
 * vi: null and meta.translationAvailable === false, so the app can show
 * "chưa có bản dịch — bấm thử lại" instead of losing the whole lesson.
 * Caption failure IS fatal: inventing subtitles for a video that has none
 * is never acceptable — the error message (Vietnamese) is returned instead.
 */

const { extractVideoId } = require('./videoId');
const { fetchJapaneseCaptions, CaptionError } = require('./captions');
const { parseJson3 } = require('./parse');
const { translateTexts, TranslateError } = require('./translate');
const { translateTextsFree } = require('./translate-free');
const { annotateLines } = require('./furigana');

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
 * @param {{ videoId: string, title: string, durationSec: number|null, source: 'manual'|'auto', json3: Object }} fetched
 * @param {{ translate?: Function }} opts — translator override; default is the paid one.
 */
async function buildLessonFromFetched(fetched, opts = {}) {
  const translate = opts.translate || paidTranslator;
  const { videoId, title, durationSec, source, json3 } = fetched;
  const lines = parseJson3(json3);
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

  // 5. Furigana + romaji.
  const annotated = await annotateLines(lines);

  const warnings = [];
  if (source === 'auto') {
    warnings.push(
      'Phụ đề tự động của YouTube — đã ghi nhận có lỗi nhận dạng (vd video test có ~4 lỗi/1 phút). Cần người soát lại từng câu trước khi dạy.'
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
 * Build a lesson JSON from a YouTube URL or video ID.
 * @param {{ url?: string, videoId?: string }} input
 * @returns {Promise<Object>} lesson JSON (see README for the schema)
 * @throws {VideoIdError|CaptionError} on invalid input / no captions
 */
async function buildLesson(input) {
  const videoId = resolveVideoId(input);

  const fetched = await fetchJapaneseCaptions(videoId);
  return buildLessonFromFetched({ videoId, ...fetched });
}

/**
 * FREE variant of buildLesson: same pipeline, but translation goes through
 * the unofficial free Google Translate endpoint (src/translate-free.js)
 * instead of the paid Cloud Translation API. Translation failure is
 * non-fatal: the lesson still returns with vi: null on the untranslated
 * lines and meta.translationStatus 'partial' / 'unavailable'.
 * @param {{ url?: string, videoId?: string }} input
 * @returns {Promise<Object>} lesson JSON (same schema as buildLesson)
 * @throws {VideoIdError|CaptionError} on invalid input / no captions
 */
async function buildLessonFree(input) {
  const videoId = resolveVideoId(input);

  const fetched = await fetchJapaneseCaptions(videoId);
  return buildLessonFromFetched({ videoId, ...fetched }, { translate: freeTranslator });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildLesson, buildLessonFree, buildLessonFromFetched };
