'use strict';
/**
 * local-test.js — local test harness for the SoraKanji subtitle backend.
 *
 * Run:  npm test        (from functions/)
 *       node test/local-test.js
 *
 * What it tests (no Firebase emulator, no credentials needed):
 *   0. Video ID extraction from URLs / raw IDs / invalid inputs.
 *   1. LIVE caption fetch against real YouTube (3 videos). NOTE: this step
 *      is environment-dependent. From this dev VM YouTube answers with
 *      HTTP 429 + a sign-in challenge (the VM's datacenter IP is bot-flagged)
 *      and degraded Innertube player responses — so a failure here means
 *      "blocked from this machine", NOT "the code is broken". The step is
 *      reported, never fails the suite. Re-run from Google Cloud (or any
 *      residential IP) to see it pass.
 *   2. Fixture pipeline: raw auto-sub JSON3 for mKPRQF70PvA (reconstructed
 *      from the browser transcript fetch of 2026-11-10, WITH its 4 known
 *      errors) -> parse/merge -> compare against the known CORRECTED
 *      transcript. The 4 raw errors must show up as discrepancies, proving
 *      the pipeline surfaces raw errors instead of silently fixing them.
 *   3. Track selection: manual Japanese preferred over auto Japanese.
 *   4. No-captions path: real fetchJapaneseCaptions with a mocked player
 *      response -> CaptionError NO_CAPTIONS with a Vietnamese message.
 *   5. Full pipeline end-to-end on fixtures (stub translator, clearly
 *      marked) -> lesson JSON schema validation.
 *   6. Kuromoji furigana + romaji accuracy on real sentences.
 *   7. Romaji converter unit checks.
 *
 * Translation is tested with the STUB translator (SORAKANJI_TRANSLATE_STUB=1
 * is set by this script). Real Google Translate is NOT tested here because
 * no GCP credentials exist on this machine — see README/DEPLOY.md.
 * Exit code: 0 when all non-live steps pass; 1 otherwise.
 */

process.env.SORAKANJI_TRANSLATE_STUB = '1';

const fs = require('node:fs');
const path = require('node:path');
const { extractVideoId, VideoIdError } = require('../src/videoId');
const { fetchJapaneseCaptions, pickJapaneseTrack, CaptionError } = require('../src/captions');
const { parseJson3 } = require('../src/parse');
const { kanaToRomaji } = require('../src/romaji');
const { annotateLine } = require('../src/furigana');
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
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

// Known CORRECTED transcript for mKPRQF70PvA (from the 2026-11-10 browser
// fetch; auto-sub errors hand-fixed). Used as the comparison target.
const CORRECTED = [
  'スイスで何をしましたか？',
  'アルプスの山に登ったり、電車で旅行したりしました。',
  'すごいね。',
  'たくさん色々なことができました。',
  'いいですね。',
  'いいな。',
  'どのぐらいスイスにいましたか？',
  '1ヶ月ぐらいいました。',
  '長いですね。',
  'はい。',
  'うん。',
  '実は友達がスイス人なので',
  'はい。',
  '家に泊まりました。',
  '良かったですね。',
  'だからお金をあまり使いませんでした。',
  'スイスは物価が高いですよね。',
  'すごく高いです。',
  'すごく高いですね。',
  '日本より高いです。',
  'そうですよね。',
  '高い、高かったですか？',
  'はい。',
];
// The 6 sentences the task requires to be present in the fetch:
const KEY_SENTENCES = [
  'スイスで何をしましたか？',
  'アルプスの山に登ったり、電車で旅行したりしました。',
  '1ヶ月ぐらいいました。',
  '実は友達がスイス人なので',
  '家に泊まりました。',
  'スイスは物価が高いですよね。',
];

async function main() {
  // ---------------------------------------------------------- Step 0: videoId
  section('Step 0 — video ID extraction');
  const idCases = [
    ['mKPRQF70PvA', 'mKPRQF70PvA'],
    ['https://www.youtube.com/watch?v=mKPRQF70PvA', 'mKPRQF70PvA'],
    ['https://www.youtube.com/watch?v=mKPRQF70PvA&t=12s', 'mKPRQF70PvA'],
    ['https://youtu.be/mKPRQF70PvA', 'mKPRQF70PvA'],
    ['https://www.youtube.com/shorts/mKPRQF70PvA', 'mKPRQF70PvA'],
    ['https://www.youtube.com/embed/mKPRQF70PvA', 'mKPRQF70PvA'],
    ['https://music.youtube.com/watch?v=mKPRQF70PvA&list=PL123', 'mKPRQF70PvA'],
    ['  mKPRQF70PvA  ', 'mKPRQF70PvA'],
  ];
  let idPass = 0;
  for (const [input, expected] of idCases) {
    try {
      const got = extractVideoId(input);
      if (got === expected) idPass += 1;
      else record(0, `extract ${input}`, 'FAIL', `got ${got}`);
    } catch (e) {
      record(0, `extract ${input}`, 'FAIL', e.message);
    }
  }
  const badInputs = ['', 'hello', 'https://example.com/watch?v=mKPRQF70PvA', 'https://www.youtube.com/watch?v=short', 'mKPRQF70PvAEXTRA'];
  let badPass = 0;
  for (const input of badInputs) {
    try {
      extractVideoId(input);
      record(0, `reject ${JSON.stringify(input)}`, 'FAIL', 'accepted an invalid input');
    } catch (e) {
      if (e instanceof VideoIdError) badPass += 1;
      else record(0, `reject ${JSON.stringify(input)}`, 'FAIL', `wrong error: ${e.message}`);
    }
  }
  record(0, `videoId: ${idPass}/${idCases.length} valid, ${badPass}/${badInputs.length} invalid rejected`, idPass === idCases.length && badPass === badInputs.length ? 'PASS' : 'FAIL');

  // ---------------------------------------------------------- Step 1: LIVE fetch
  section('Step 1 — LIVE caption fetch (environment-dependent, non-fatal)');
  const liveVideos = [
    ['mKPRQF70PvA', 'Easy N5 Japanese Podcast (known: auto ja only)'],
    ['r_o5gRWkkaA', "SoraKanji sample n5-1-1 (own upload, sub status unknown)"],
    ['dQw4w9WgXcQ', 'Rick Astley (likely auto subs, not Japanese)'],
  ];
  for (const [vid, note] of liveVideos) {
    try {
      const r = await fetchJapaneseCaptions(vid);
      record(1, `live ${vid} (${note})`, 'PASS', `source=${r.source}, title="${r.title}", lines=${parseJson3(r.json3).length}`);
    } catch (e) {
      record(1, `live ${vid} (${note})`, 'BLOCKED', `${e.code || e.name}: ${e.message}`);
    }
  }

  // ---------------------------------------------------------- Step 2: fixture parse
  section('Step 2 — fixture parse/merge vs known corrected transcript (mKPRQF70PvA)');
  const autoJson3 = loadFixture('mKPRQF70PvA.auto.json3.json');
  const merged = parseJson3(autoJson3);
  console.log(`  merged lines: ${merged.length}`);
  merged.forEach((l) => console.log(`    ${l.start.toFixed(2)}s  ${l.jp}`));
  const mergedTexts = merged.map((l) => l.jp);
  // Normalised comparison: leading spoken interjections (え、/あ、/ま、/うん。)
  // are real speech, not errors — strip them before comparing to the
  // hand-cleaned transcript (which drops them). Only strip when more text
  // follows, so a bare "はい。" / "うん。" line is kept as-is.
  const norm = (s) => s.replace(/^(え|あ|ま|うん|はい|えっと|あの)[、。](?=\S)/, '').trim();
  const mergedNorm = mergedTexts.map(norm);
  const exactMatches = CORRECTED.filter((c) => mergedNorm.includes(c)).length;
  // Key sentences: each must be present either in corrected form or in its
  // known raw auto-sub form (the raw fetch keeps the errors — that is the
  // point: the pipeline must show them, not fix them).
  const RAW_VARIANTS = {
    '1ヶ月ぐらいいました。': '1ヶ月ぐらいました。',
    '実は友達がスイス人なので': '実は友達がスイス数の人なので',
    '家に泊まりました。': '家に止まりました。',
  };
  const keyPresent = KEY_SENTENCES.filter((k) =>
    mergedTexts.some((m) => m.includes(k) || (RAW_VARIANTS[k] && m.includes(RAW_VARIANTS[k])))
  );
  // Pure interjection lines (もう。) are faithful speech, not errors.
  const PURE_INTERJECTION = /^(もう|はい|うん|え|あ)[。．]$/;
  const discrepancies = mergedTexts.filter((m) => !CORRECTED.includes(norm(m)) && !PURE_INTERJECTION.test(m));
  console.log(`  exact matches vs corrected transcript (normalised): ${exactMatches}/${CORRECTED.length}`);
  console.log(`  key sentences present: ${keyPresent.length}/${KEY_SENTENCES.length}`);
  console.log(`  lines NOT matching the corrected transcript:`);
  discrepancies.forEach((d) => console.log(`    - ${d}`));
  // The 4 known raw auto-sub errors (plus the garbled 0:50 line) must appear
  // verbatim in the output — the pipeline must NOT silently fix them.
  const expectDiscrepancies = [
    'え、どのぐらいスにましたか？',
    '1ヶ月ぐらいました。',
    '実は友達がスイス数の人なので',
    'え、家に止まりました。',
  ];
  const rawErrorsSurfaced = expectDiscrepancies.filter((e) => mergedTexts.includes(e));
  const garbled050 = mergedTexts.some((m) => m.includes('レストラン、コーヒーも全部'));
  record(
    2,
    'raw auto-sub errors surface as discrepancies (not silently fixed)',
    rawErrorsSurfaced.length === expectDiscrepancies.length && garbled050 ? 'PASS' : 'FAIL',
    `${rawErrorsSurfaced.length}/${expectDiscrepancies.length} known raw errors present in output; 0:50 garbled line present: ${garbled050}`
  );
  record(
    2,
    `exact matches ${exactMatches}/${CORRECTED.length} (misses should be exactly the 4 raw errors)`,
    exactMatches === CORRECTED.length - expectDiscrepancies.length ? 'PASS' : 'FAIL',
    `missing: ${CORRECTED.filter((c) => !mergedNorm.includes(c)).join(' | ') || 'none'}`
  );
  record(
    2,
    'all 6 key sentences present',
    keyPresent.length === KEY_SENTENCES.length ? 'PASS' : 'FAIL',
    `missing: ${KEY_SENTENCES.filter((k) => !keyPresent.includes(k)).join(' | ') || 'none'}`
  );

  // ---------------------------------------------------------- Step 3: track selection
  section('Step 3 — track selection (manual ja > auto ja)');
  const playerMock = loadFixture('player-manual-auto.json');
  const picked = pickJapaneseTrack(playerMock.captions.playerCaptionsTracklistRenderer.captionTracks);
  record(
    3,
    'prefers manual Japanese track',
    picked && picked.source === 'manual' && picked.languageCode === 'ja' ? 'PASS' : 'FAIL',
    picked ? `source=${picked.source}, name=${picked.name}` : 'no track picked'
  );
  record(3, 'ignores non-Japanese tracks when ja exists', picked && picked.languageCode === 'ja' ? 'PASS' : 'FAIL');
  record(3, 'no Japanese track -> null', pickJapaneseTrack([{ languageCode: 'en', baseUrl: 'https://x' }]) === null ? 'PASS' : 'FAIL');

  // ---------------------------------------------------------- Step 4: no captions
  section('Step 4 — no-captions path (mocked player response, real code)');
  const noCapPlayer = loadFixture('player-nocaptions.json');
  try {
    await fetchJapaneseCaptions('NOCAP-TEST', { fetchPlayerResponse: async () => noCapPlayer });
    record(4, 'no captions -> NO_CAPTIONS error', 'FAIL', 'did not throw');
  } catch (e) {
    record(
      4,
      'no captions -> NO_CAPTIONS error',
      e instanceof CaptionError && e.code === 'NO_CAPTIONS' ? 'PASS' : 'FAIL',
      `${e.code || e.name}: ${e.message}`
    );
  }

  // ---------------------------------------------------------- Step 5: full pipeline on fixtures
  section('Step 5 — full pipeline end-to-end on fixtures (stub translator)');
  const lessonAuto = await buildLessonFromFetched({
    videoId: 'mKPRQF70PvA',
    title: 'Easy N5 Japanese Podcast',
    durationSec: 62,
    source: 'auto',
    json3: autoJson3,
  });
  const schemaOk =
    lessonAuto.videoId === 'mKPRQF70PvA' &&
    lessonAuto.source === 'auto' &&
    Array.isArray(lessonAuto.lines) &&
    lessonAuto.lines.length > 0 &&
    lessonAuto.lines.every(
      (l) =>
        typeof l.start === 'number' &&
        typeof l.jp === 'string' &&
        typeof l.reading === 'string' &&
        typeof l.romaji === 'string' &&
        l.viAuto === true &&
        typeof l.vi === 'string' &&
        l.vi.startsWith('[DỊCH MÁY - STUB]')
    );
  record(5, 'auto-sub lesson JSON schema + stub-marked vi', schemaOk ? 'PASS' : 'FAIL', `lines=${lessonAuto.lines.length}, meta.warnings=${lessonAuto.meta.warnings.length}`);
  console.log('  sample line:', JSON.stringify(lessonAuto.lines[0]));
  console.log('  meta warnings:', lessonAuto.meta.warnings);
  const manualJson3 = loadFixture('manual-ja.json3.json');
  const lessonManual = await buildLessonFromFetched({
    videoId: 'MANUAL-TEST',
    title: 'Track selection test',
    durationSec: 120,
    source: 'manual',
    json3: manualJson3,
  });
  record(
    5,
    'manual-sub lesson: source=manual, 3 lines, no auto-sub warning',
    lessonManual.source === 'manual' &&
      lessonManual.lines.length === 3 &&
      !lessonManual.meta.warnings.some((w) => w.includes('tự động'))
      ? 'PASS'
      : 'FAIL',
    `lines=${lessonManual.lines.length}`
  );

  // ---------------------------------------------------------- Step 6: furigana accuracy
  section('Step 6 — kuromoji furigana + romaji accuracy (real sentences)');
  const furiCases = [
    ['スイスで何をしましたか？', 'スイスでなにをしましたか？', 'suisu de nani wo shimashita ka?'],
    ['1ヶ月ぐらいいました。', 'いっかげつぐらいいました。', 'ikkagetsu gurai imashita.'],
    ['実は友達がスイス人なので', 'じつはともだちがスイスじんなので', 'jitsu wa tomodachi ga suisu-jin na node'],
    ['スイスは物価が高いですよね。', 'スイスはぶっかがたかいですよね。', 'suisu wa bukka ga takai desu yo ne.'],
    ['高い、高かったですか？', 'たかい、たかかったですか？', 'takai, takakatta desu ka?'],
    ['アルプスの山に登ったり、電車で旅行したりしました。', 'アルプスのやまにのぼったり、でんしゃでりょこうしたりしました。', 'arupusu no yama ni nobottari, densha de ryokou shitari shimashita.'],
    ['2026年に日本へ来ました。', 'にせんにじゅうろくねんににっぽんへきました。', 'nisennijuurokunen ni nippon e kimashita.'],
    ['3人でご飯を食べました。', 'さんにんでごはんをたべました。', 'sannin de gohan wo tabemashita.'],
    ['100円です。', 'ひゃくえんです。', 'hyakuen desu.'],
    ['11月3日は祝日です。', 'じゅういちがつみっかはしゅくじつです。', 'juuichigatsumikka wa shukujitsu desu.'],
    ['こんにちは、元気ですか。', 'こんにちは、げんきですか。', 'konnichiwa, genki desu ka.'],
  ];
  for (const [jp, wantReading, wantRomaji] of furiCases) {
    const a = await annotateLine(jp);
    const okR = a.reading === wantReading;
    const okRo = a.romaji === wantRomaji;
    record(
      6,
      `furigana: ${jp}`,
      okR && okRo ? 'PASS' : 'FAIL',
      `reading=${a.reading} ${okR ? '' : `(want ${wantReading})`} | romaji=${a.romaji} ${okRo ? '' : `(want ${wantRomaji})`}`
    );
  }

  // ---------------------------------------------------------- Step 7: romaji units
  section('Step 7 — romaji converter units');
  const romaCases = [
    ['ぶっか', 'bukka'],
    ['まっちゃ', 'matcha'],
    ['ほんやく', "hon'yaku"],
    ['がっこう', 'gakkou'],
    ['きって', 'kitte'],
    ['すごい', 'sugoi'],
    ['りょこう', 'ryokou'],
    ['しんぶん', 'shinbun'],
    ['かんじ', 'kanji'],
    ['コーヒー', 'koohii'],
    ['ショー', 'shoo'],
    ['スーパー', 'suupaa'],
    ['きっちり', 'kitchiri'],
    ['じっさい', 'jissai'],
  ];
  let romaPass = 0;
  for (const [kana, want] of romaCases) {
    const got = kanaToRomaji(kana);
    if (got === want) romaPass += 1;
    else record(7, `romaji ${kana}`, 'FAIL', `got ${got}, want ${want}`);
  }
  record(7, `romaji units ${romaPass}/${romaCases.length}`, romaPass === romaCases.length ? 'PASS' : 'FAIL');

  // ---------------------------------------------------------- Summary
  section('Summary');
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`  PASS: ${counts.PASS} | FAIL: ${counts.FAIL} | BLOCKED (environment): ${counts.BLOCKED}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log('  Failures:');
    failed.forEach((f) => console.log(`    - step ${f.step}: ${f.name} — ${f.detail || ''}`));
  }
  console.log('\nNOT tested live here (no credentials / YouTube blocked from this VM):');
  console.log('  - Real Google Cloud Translation (stub used instead, clearly marked).');
  console.log('  - Real YouTube caption fetch (blocked: HTTP 429 + sign-in challenge).');
  console.log('  - Firebase onCall deploy (needs user login + billing; see DEPLOY.md).');
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
