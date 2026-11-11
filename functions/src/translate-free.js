'use strict';
/**
 * translate-free.js — Japanese lines -> Vietnamese via the UNOFFICIAL free
 * Google Translate web endpoint:
 *   https://translate.googleapis.com/translate_a/single?client=gtx
 *   &sl=ja&tl=vi&dt=t&q=<text>&q=<text>...
 * No API key, no billing, no Cloud Translation API — so this path runs on
 * the Firebase Spark (free) plan. TEMPORARY: the endpoint is not a
 * supported API. Google rate-limits it aggressively — verified 2026-11-11:
 * from this dev VM the first sentence translated, the next two immediately
 * got HTTP 429, and a retry 20 s later was still 429. The egress IP of
 * Cloud Functions is different, so it may work there, but it MUST be
 * verified live after deploy (DEPLOY.md "Đường FREE") and it can break at
 * any time. The paid path (src/translate.js, Cloud Translation API) stays
 * the long-term route.
 *
 * Honesty rules (same as the rest of the pipeline):
 *   - A failed chunk NEVER produces a guessed translation: its lines get
 *     vi: null and the lesson reports translationStatus 'partial' or
 *     'unavailable' with a Vietnamese message the app can show.
 *   - Response alignment is verified per line: the endpoint echoes the
 *     source text back (segment[1]). A line whose echo does not match its
 *     input is left untranslated rather than risking a wrong mapping, and
 *     a chunk whose segment count does not match its input count fails
 *     as a whole — never misalign translations.
 *   - No retry on HTTP 429: verified 2026-11-11 that it persists for at
 *     least 20 s. One retry only on network-level failure (fetch throw /
 *     timeout), after a short delay.
 */

const GTX_BASE =
  'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=vi&dt=t';
const DEFAULT_MAX_URL_CHARS = 4000; // keep GET URLs short; Google rejects very long ones
const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 800;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class FreeTranslateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FreeTranslateError';
    this.code = code; // RATE_LIMITED | FAILED | TIMEOUT
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split texts into chunks whose request URL stays within maxUrlChars.
 * Returns an array of { texts: string[], startIndex: number }.
 * A single text longer than the budget goes alone in its own chunk
 * (Google may still reject it — that chunk then fails honestly).
 */
function chunkTexts(texts, maxUrlChars = DEFAULT_MAX_URL_CHARS) {
  const chunks = [];
  let cur = [];
  let curLen = GTX_BASE.length;
  let startIndex = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const qLen = 3 + encodeURIComponent(texts[i]).length; // '&q=' + encoded
    if (cur.length > 0 && curLen + qLen > maxUrlChars) {
      chunks.push({ texts: cur, startIndex });
      cur = [];
      curLen = GTX_BASE.length;
      startIndex = i;
    }
    cur.push(texts[i]);
    curLen += qLen;
  }
  if (cur.length > 0) chunks.push({ texts: cur, startIndex });
  return chunks;
}

function buildGtxUrl(chunkTexts) {
  const params = chunkTexts.map((t) => `q=${encodeURIComponent(t)}`).join('&');
  return `${GTX_BASE}&${params}`;
}

/**
 * Parse one gtx JSON response for a chunk.
 * Shape: [[["dịch","gốc",...], ["dịch2","gốc2",...]], null, "ja", ...]
 * Returns an array of translations (string) or null per line.
 * Throws FreeTranslateError('FAILED') when the shape is unusable —
 * the caller then fails the whole chunk rather than misaligning lines.
 */
function parseGtxResponse(json, chunk) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) {
    throw new FreeTranslateError('FAILED', 'Đầu dịch miễn phí trả về định dạng không nhận dạng được.');
  }
  const segments = json[0];
  if (segments.length !== chunk.length) {
    throw new FreeTranslateError(
      'FAILED',
      `Đầu dịch miễn phí trả về ${segments.length} câu cho ${chunk.length} câu gửi đi — không dám gán lệch, bỏ qua chunk này.`
    );
  }
  return segments.map((seg, i) => {
    if (!Array.isArray(seg) || typeof seg[0] !== 'string') return null;
    // Echo guard: the endpoint returns the source text as seg[1].
    // If it does not match what we sent, do not trust the pairing.
    const echo = typeof seg[1] === 'string' ? seg[1] : null;
    if (echo !== null && echo.replace(/\s+/g, ' ').trim() !== chunk[i].replace(/\s+/g, ' ').trim()) {
      return null;
    }
    const t = seg[0].trim();
    return t.length > 0 ? t : null;
  });
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new FreeTranslateError('TIMEOUT', 'Hết thời gian chờ khi gọi đầu dịch miễn phí.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate one chunk. Returns { translations, error } where error is a
 * FreeTranslateError (or null). Never throws for HTTP errors — the caller
 * decides the lesson-level status from per-chunk results.
 * Network-level failures get ONE retry after a short delay.
 */
async function translateChunk(chunk, opts) {
  const url = buildGtxUrl(chunk);
  let res;
  try {
    res = await fetchWithTimeout(url, opts.fetchImpl, opts.timeoutMs);
  } catch (err) {
    if (err instanceof FreeTranslateError) {
      // Timeout: one retry, then give up on this chunk.
      try {
        await sleep(RETRY_DELAY_MS);
        res = await fetchWithTimeout(url, opts.fetchImpl, opts.timeoutMs);
      } catch (err2) {
        return { translations: chunk.map(() => null), error: err2 };
      }
    } else {
      // Network error: one retry, then give up on this chunk.
      try {
        await sleep(RETRY_DELAY_MS);
        res = await fetchWithTimeout(url, opts.fetchImpl, opts.timeoutMs);
      } catch (err2) {
        return {
          translations: chunk.map(() => null),
          error: new FreeTranslateError('FAILED', `Không gọi được đầu dịch miễn phí: ${err2.message || err2}`),
        };
      }
    }
  }
  if (!res.ok) {
    if (res.status === 429) {
      return {
        translations: chunk.map(() => null),
        error: new FreeTranslateError(
          'RATE_LIMITED',
          'Google đang chặn dịch tự động (HTTP 429), thử lại sau vài phút.'
        ),
      };
    }
    return {
      translations: chunk.map(() => null),
      error: new FreeTranslateError(
        'FAILED',
        `Đầu dịch miễn phí trả về HTTP ${res.status}.`
      ),
    };
  }
  let body;
  try {
    body = await res.text();
  } catch (err) {
    return {
      translations: chunk.map(() => null),
      error: new FreeTranslateError('FAILED', `Không đọc được phản hồi của đầu dịch miễn phí: ${err.message || err}`),
    };
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return {
      translations: chunk.map(() => null),
      error: new FreeTranslateError('FAILED', 'Đầu dịch miễn phí trả về nội dung không phải JSON (có thể là trang chặn bot).'),
    };
  }
  try {
    return { translations: parseGtxResponse(json, chunk), error: null };
  } catch (err) {
    return { translations: chunk.map(() => null), error: err };
  }
}

/**
 * Translate an array of Japanese strings to Vietnamese via the free endpoint.
 * @param {string[]} texts
 * @param {{ fetchImpl?: Function, maxUrlChars?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ translations: (string|null)[], status: 'ok'|'partial'|'unavailable', error: string|null }>}
 *   status 'ok'        — every line translated.
 *   status 'partial'   — some lines translated, the rest are null.
 *   status 'unavailable' — nothing translated; error is a Vietnamese message.
 * Never throws for translation failure (only for programmer errors).
 */
async function translateTextsFree(texts, opts = {}) {
  if (texts.length === 0) return { translations: [], status: 'ok', error: null };
  const options = {
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    maxUrlChars: opts.maxUrlChars || DEFAULT_MAX_URL_CHARS,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
  if (typeof options.fetchImpl !== 'function') {
    return {
      translations: texts.map(() => null),
      status: 'unavailable',
      error: 'Không có hàm fetch để gọi đầu dịch miễn phí.',
    };
  }
  const chunks = chunkTexts(texts, options.maxUrlChars);
  const translations = texts.map(() => null);
  let translatedCount = 0;
  let rateLimited = false;
  let firstError = null;
  for (const { texts: chunk, startIndex } of chunks) {
    const { translations: got, error } = await translateChunk(chunk, options);
    got.forEach((t, j) => {
      if (t !== null) {
        translations[startIndex + j] = t;
        translatedCount += 1;
      }
    });
    if (error) {
      if (error.code === 'RATE_LIMITED') rateLimited = true;
      if (!firstError) firstError = error;
    }
  }
  if (translatedCount === texts.length) {
    return { translations, status: 'ok', error: null };
  }
  if (translatedCount === 0) {
    const msg = rateLimited
      ? 'Google đang chặn dịch tự động, thử lại sau vài phút. Bài học vẫn có câu Nhật + furigana, phần dịch Việt để trống.'
      : `${firstError ? firstError.message : 'Không dịch được sang tiếng Việt.'} Bài học vẫn có câu Nhật + furigana, phần dịch Việt để trống.`;
    return { translations, status: 'unavailable', error: msg };
  }
  return {
    translations,
    status: 'partial',
    error: `Một phần câu chưa dịch được (${rateLimited ? 'Google chặn dịch tự động' : firstError ? firstError.message : 'lỗi đầu dịch'}), thử lại sau vài phút.`,
  };
}

module.exports = {
  translateTextsFree,
  FreeTranslateError,
  chunkTexts,
  buildGtxUrl,
  parseGtxResponse,
  GTX_BASE,
  DEFAULT_MAX_URL_CHARS,
};
