'use strict';
/**
 * translate.js — Japanese lines -> Vietnamese via Google Cloud Translation API (v2).
 *
 * In production the call uses Application Default Credentials: inside Cloud
 * Functions the function's service account is used automatically, so no key
 * is stored in code. Requirements (see DEPLOY.md): enable the Cloud
 * Translation API on project donghung-3208d and attach billing.
 *
 * STUB MODE (local testing only, never in production):
 *   SORAKANJI_TRANSLATE_STUB=1  -> returns "[DỊCH MÁY - STUB] <jp>" lines.
 * The stub output is deliberately marked so it can never be mistaken for a
 * real translation. Real translations are machine translations too: every
 * line is flagged viAuto: true so the app shows a "bản dịch máy" badge and
 * the content stays reviewable before it is taught.
 */

const { Translate } = require('@google-cloud/translate').v2;

class TranslateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranslateError';
    this.code = 'TRANSLATE_FAILED';
  }
}

let client = null;
function getClient() {
  if (!client) client = new Translate();
  return client;
}

const STUB_PREFIX = '[DỊCH MÁY - STUB] ';

function isStubMode() {
  return process.env.SORAKANJI_TRANSLATE_STUB === '1';
}

function isSkipMode() {
  return process.env.SORAKANJI_SKIP_TRANSLATE === '1';
}

/**
 * Translate an array of Japanese strings to Vietnamese.
 * Returns { translations: string[], stub: boolean, skipped: boolean }.
 * Throws TranslateError on failure (caller decides whether to fail the
 * whole lesson or continue with vi: null).
 */
async function translateTexts(texts) {
  if (texts.length === 0) return { translations: [], stub: false, skipped: false };
  if (isSkipMode()) {
    return { translations: texts.map(() => null), stub: false, skipped: true };
  }
  if (isStubMode()) {
    return { translations: texts.map((t) => `${STUB_PREFIX}${t}`), stub: true, skipped: false };
  }
  const api = getClient();
  const out = [];
  // v2 allows up to 128 strings / request; keep chunks small for safety.
  const CHUNK = 50;
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    try {
      const [translations] = await api.translate(chunk, 'vi');
      out.push(...(Array.isArray(translations) ? translations : [translations]));
    } catch (err) {
      const hint = /PERMISSION_DENIED|API not enabled|billing/i.test(err.message || '')
        ? ' Kiểm tra DEPLOY.md: bật Cloud Translation API + billing cho project donghung-3208d.'
        : '';
      throw new TranslateError(`Dịch sang tiếng Việt thất bại: ${err.message || err}.${hint}`);
    }
  }
  return { translations: out, stub: false };
}

module.exports = { translateTexts, TranslateError, isStubMode, isSkipMode, STUB_PREFIX };
