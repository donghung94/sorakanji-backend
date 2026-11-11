'use strict';
/**
 * free-test.js — tests for the FREE path (gen-1 function + unofficial
 * Google Translate endpoint, src/translate-free.js).
 *
 * Run:  npm test        (from functions/ — runs local-test.js then this)
 *       node test/free-test.js
 *
 * The real free endpoint is NOT called here: it is rate-limited from this
 * dev VM (verified 2026-11-11: HTTP 429 after the first sentence), so all
 * network behaviour is tested with a mocked fetch. A live check of the
 * endpoint from Cloud Functions IPs is a post-deploy step (DEPLOY.md).
 *
 * What it tests (mocked fetch):
 *   1. Success path: translations land, status 'ok'.
 *   2. HTTP 429 -> status 'unavailable', all vi null, Vietnamese message.
 *   3. Partial: one chunk OK + one chunk 429 -> status 'partial'.
 *   4. Chunking: short video = 1 request; tiny budget = many requests.
 *   5. Malformed (non-JSON) 200 body -> 'unavailable', no crash.
 *   6. Echo mismatch guard: a line whose echoed source differs is left
 *      untranslated instead of risking a wrong mapping.
 *   7. Segment-count mismatch -> whole chunk fails, never misaligned.
 *   8. Empty input -> ok, no fetch call.
 *   9. Full lesson via buildLessonFromFetched + free translator (mocked):
 *      schema intact, meta.translationStatus 'ok'.
 *  10. Full lesson with 429: jp + furigana + romaji still returned,
 *      vi null, meta.translationStatus 'unavailable', Vietnamese message.
 *  11. Both function exports load from index.js (gen 2 + gen 1).
 *
 * Exit code: 0 when all steps pass; 1 otherwise.
 */

const fs = require('node:fs');
const path = require('node:path');
const { translateTextsFree, chunkTexts } = require('../src/translate-free');
const { buildLessonFromFetched } = require('../src/pipeline');

const FIX = path.join(__dirname, 'fixtures');
const results = [];
function record(step, name, status, detail) {
  results.push({ step, name, status, detail });
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  console.log(`  ${mark} [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

/** Build a gtx JSON body: [[["vi1","jp1",...], ["vi2","jp2",...]], null, "ja"]. */
function gtxBody(pairs) {
  return JSON.stringify([pairs.map(([t, o]) => [t, o, null, null, 3]), null, 'ja']);
}

/** Mock fetch: handler(url, callIndex) -> { ok, status, text }. Records calls. */
function mockFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = handler(url, calls.length);
    return { ok: r.ok, status: r.status, text: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

/** Mock that translates every q param as `VI(<q>)`, echoing the source. */
function translatingFetch() {
  return mockFetch((url) => {
    const u = new URL(url);
    const qs = u.searchParams.getAll('q');
    return { ok: true, status: 200, body: gtxBody(qs.map((q) => [`VI(${q})`, q])) };
  });
}

const SENTENCES = [
  'スイスで何をしましたか？',
  '1ヶ月ぐらいいました。',
  'スイスは物価が高いですよね。',
];

async function main() {
  // ---------------------------------------------------------- Step 1: success
  section('Step 1 — free translate success path');
  {
    const res = await translateTextsFree(SENTENCES, { fetchImpl: translatingFetch() });
    record(
      1,
      'all lines translated, status ok',
      res.status === 'ok' &&
        res.translations.length === 3 &&
        res.translations[0] === 'VI(スイスで何をしましたか？)' &&
        res.error === null
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(res.translations)
    );
  }

  // ---------------------------------------------------------- Step 2: 429
  section('Step 2 — HTTP 429 -> unavailable, vi null, Vietnamese message');
  {
    const fetch429 = mockFetch(() => ({
      ok: false,
      status: 429,
      body: '<html><head><title>Sorry...</title></head><body>bot check</body></html>',
    }));
    const res = await translateTextsFree(SENTENCES, { fetchImpl: fetch429 });
    record(
      2,
      '429 -> unavailable + all null + Vietnamese message',
      res.status === 'unavailable' &&
        res.translations.every((t) => t === null) &&
        typeof res.error === 'string' &&
        res.error.includes('Google đang chặn dịch tự động')
        ? 'PASS'
        : 'FAIL',
      `status=${res.status}, error=${res.error}`
    );
  }

  // ---------------------------------------------------------- Step 3: partial
  section('Step 3 — partial: first chunk OK, later chunks 429');
  {
    // Tiny URL budget forces one sentence per chunk (4 calls for 4 lines).
    const lines = [...SENTENCES, 'はい。'];
    const fetchMixed = mockFetch((url, callNo) => {
      if (callNo === 1) {
        const qs = new URL(url).searchParams.getAll('q');
        return { ok: true, status: 200, body: gtxBody(qs.map((q) => [`VI(${q})`, q])) };
      }
      return { ok: false, status: 429, body: '<html>Sorry...</html>' };
    });
    const res = await translateTextsFree(lines, { fetchImpl: fetchMixed, maxUrlChars: 200 });
    record(
      3,
      'partial: first line translated, rest null, status partial',
      res.status === 'partial' &&
        res.translations[0] === 'VI(スイスで何をしましたか？)' &&
        res.translations.slice(1).every((t) => t === null)
        ? 'PASS'
        : 'FAIL',
      `status=${res.status}, translations=${JSON.stringify(res.translations)}`
    );
  }

  // ---------------------------------------------------------- Step 4: chunking
  section('Step 4 — chunking: fewest requests possible');
  {
    const fetchOk = translatingFetch();
    const res = await translateTextsFree(SENTENCES, { fetchImpl: fetchOk });
    record(
      4,
      'short video (3 lines) = 1 request',
      fetchOk.calls.length === 1 && res.status === 'ok' ? 'PASS' : 'FAIL',
      `calls=${fetchOk.calls.length}`
    );
    const fetchTiny = translatingFetch();
    const resTiny = await translateTextsFree(SENTENCES, { fetchImpl: fetchTiny, maxUrlChars: 200 });
    record(
      4,
      'tiny budget splits into several requests, all still translated',
      fetchTiny.calls.length === SENTENCES.length && resTiny.status === 'ok' ? 'PASS' : 'FAIL',
      `calls=${fetchTiny.calls.length}`
    );
    const one = chunkTexts(['a'.repeat(5000)]);
    record(
      4,
      'one over-budget line still yields exactly 1 chunk (never dropped)',
      one.length === 1 && one[0].texts.length === 1 ? 'PASS' : 'FAIL',
      `chunks=${one.length}`
    );
  }

  // ---------------------------------------------------------- Step 5: malformed body
  section('Step 5 — malformed 200 body -> unavailable, no crash');
  {
    const fetchBad = mockFetch(() => ({ ok: true, status: 200, body: '<html>Sorry...</html>' }));
    const res = await translateTextsFree(SENTENCES, { fetchImpl: fetchBad });
    record(
      5,
      'non-JSON body -> unavailable, all null',
      res.status === 'unavailable' && res.translations.every((t) => t === null) ? 'PASS' : 'FAIL',
      `status=${res.status}`
    );
  }

  // ---------------------------------------------------------- Step 6: echo guard
  section('Step 6 — echo mismatch guard');
  {
    const fetchEcho = mockFetch((url) => {
      const qs = new URL(url).searchParams.getAll('q');
      const pairs = qs.map((q, i) => (i === 1 ? ['BẢN DỊCH SAI CHỖ', 'câu gốc khác hẳn'] : [`VI(${q})`, q]));
      return { ok: true, status: 200, body: gtxBody(pairs) };
    });
    const res = await translateTextsFree(SENTENCES, { fetchImpl: fetchEcho });
    record(
      6,
      'line with mismatched echo is left null, others translated, status partial',
      res.status === 'partial' &&
        res.translations[0] !== null &&
        res.translations[1] === null &&
        res.translations[2] !== null
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(res.translations)
    );
  }

  // ---------------------------------------------------------- Step 7: count mismatch
  section('Step 7 — segment-count mismatch -> chunk fails, never misaligned');
  {
    const fetchShort = mockFetch(() => ({
      ok: true,
      status: 200,
      body: gtxBody([['chỉ một câu', SENTENCES[0]]]),
    }));
    const res = await translateTextsFree(SENTENCES, { fetchImpl: fetchShort });
    record(
      7,
      '1 segment for 3 inputs -> unavailable, all null',
      res.status === 'unavailable' && res.translations.every((t) => t === null) ? 'PASS' : 'FAIL',
      `status=${res.status}`
    );
  }

  // ---------------------------------------------------------- Step 8: empty input
  section('Step 8 — empty input');
  {
    const fetchSpy = translatingFetch();
    const res = await translateTextsFree([], { fetchImpl: fetchSpy });
    record(
      8,
      'empty -> ok, no fetch call',
      res.status === 'ok' && res.translations.length === 0 && fetchSpy.calls.length === 0 ? 'PASS' : 'FAIL',
      `calls=${fetchSpy.calls.length}`
    );
  }

  // ---------------------------------------------------------- Step 9-10: full lesson
  section('Step 9 — full lesson via free translator (mocked), fixture mKPRQF70PvA');
  {
    const autoJson3 = JSON.parse(fs.readFileSync(path.join(FIX, 'mKPRQF70PvA.auto.json3.json'), 'utf8'));
    const lesson = await buildLessonFromFetched(
      { videoId: 'mKPRQF70PvA', title: 'Easy N5 Japanese Podcast', durationSec: 62, source: 'auto', json3: autoJson3 },
      {
        translate: async (texts) => translateTextsFree(texts, { fetchImpl: translatingFetch() }),
      }
    );
    const schemaOk =
      lesson.videoId === 'mKPRQF70PvA' &&
      lesson.lines.length > 0 &&
      lesson.lines.every(
        (l) =>
          typeof l.start === 'number' &&
          typeof l.jp === 'string' &&
          typeof l.reading === 'string' &&
          typeof l.romaji === 'string' &&
          l.viAuto === true &&
          typeof l.vi === 'string' &&
          l.vi.startsWith('VI(')
      );
    record(
      9,
      'lesson schema intact, vi filled, translationStatus ok',
      schemaOk && lesson.meta.translationStatus === 'ok' && lesson.meta.translationAvailable === true ? 'PASS' : 'FAIL',
      `lines=${lesson.lines.length}, status=${lesson.meta.translationStatus}`
    );
  }
  section('Step 10 — full lesson with 429: jp + furigana kept, vi null');
  {
    const autoJson3 = JSON.parse(fs.readFileSync(path.join(FIX, 'mKPRQF70PvA.auto.json3.json'), 'utf8'));
    const fetch429 = mockFetch(() => ({ ok: false, status: 429, body: '<html>Sorry...</html>' }));
    const lesson = await buildLessonFromFetched(
      { videoId: 'mKPRQF70PvA', title: 'Easy N5 Japanese Podcast', durationSec: 62, source: 'auto', json3: autoJson3 },
      {
        translate: async (texts) => translateTextsFree(texts, { fetchImpl: fetch429 }),
      }
    );
    const keptOk =
      lesson.lines.length > 0 &&
      lesson.lines.every(
        (l) => typeof l.jp === 'string' && l.jp.length > 0 && typeof l.reading === 'string' && typeof l.romaji === 'string' && l.vi === null
      );
    record(
      10,
      '429 lesson: jp/reading/romaji kept, vi null, status unavailable + Vietnamese message',
      keptOk &&
        lesson.meta.translationStatus === 'unavailable' &&
        lesson.meta.translationAvailable === false &&
        typeof lesson.meta.translationError === 'string' &&
        lesson.meta.translationError.includes('Google đang chặn dịch tự động')
        ? 'PASS'
        : 'FAIL',
      `lines=${lesson.lines.length}, status=${lesson.meta.translationStatus}`
    );
    console.log('  meta.translationError:', lesson.meta.translationError);
    console.log('  sample line:', JSON.stringify(lesson.lines[0]));
  }

  // ---------------------------------------------------------- Step 11: exports
  section('Step 11 — index.js exports both functions (gen 2 + gen 1)');
  {
    const idx = require('../index');
    record(
      11,
      'makeLessonFromVideo (gen 2) exported',
      typeof idx.makeLessonFromVideo === 'function' ? 'PASS' : 'FAIL'
    );
    record(
      11,
      'makeLessonFromVideoFree (gen 1) exported',
      typeof idx.makeLessonFromVideoFree === 'function' ? 'PASS' : 'FAIL'
    );
  }

  // ---------------------------------------------------------- Summary
  section('Summary');
  const counts = { PASS: 0, FAIL: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`  PASS: ${counts.PASS} | FAIL: ${counts.FAIL}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log('  Failures:');
    failed.forEach((f) => console.log(`    - step ${f.step}: ${f.name} — ${f.detail || ''}`));
  }
  console.log('\nNOT tested live here (free endpoint rate-limited from this VM):');
  console.log('  - Real translate.googleapis.com call (mocked instead).');
  console.log('  - Real YouTube caption fetch from Spark egress (post-deploy check).');
  console.log('  - Firebase deploy (needs user login; see DEPLOY.md "Đường FREE").');
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
