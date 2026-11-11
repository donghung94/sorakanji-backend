'use strict';
/**
 * test-local.js — local test for the trial server WITHOUT live YouTube.
 *
 * The live caption fetch is blocked from this machine (YouTube 429 on the
 * datacenter IP), so this test exercises the HTTP endpoint with the stored
 * auto-subtitle fixture (mKPRQF70PvA.auto.json3.json) via
 * buildLessonFromFetched, plus the real server's error paths (which need
 * no network: bad link -> VideoIdError before any fetch).
 *
 * Checks:
 *   1. GET /health -> { ok: true }
 *   2. POST /makeLesson {videoId} (fixture builder) -> lesson JSON shape:
 *      29 lines, every line has jp/reading/romaji/tokens,
 *      meta.translationStatus present.
 *   3. POST /makeLesson {url: <non-YouTube>} (real builder) -> 400 +
 *      Vietnamese message, no invented lesson.
 *   4. POST /makeLesson {} (real builder) -> 400.
 *   5. Peak RSS of this process while building one lesson (kuromoji
 *      tokenizer build is the tightest moment vs Render free 512 MB).
 *
 * Run:  npm test   (from trial-server/)
 * Live YouTube + free-translate can only be verified after deploying to
 * Render (different egress IP).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./server');
const { buildLessonFromFetched } = require('../functions/src/pipeline');

const FIXTURE = path.join(
  __dirname, '..', 'functions', 'test', 'fixtures', 'mKPRQF70PvA.auto.json3.json'
);

function peakRssMB() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function rssMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

async function post(base, body) {
  const res = await fetch(`${base}/makeLesson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? '  ✓ [PASS]' : '  ✗ [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const json3 = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // Test translator: skip real translation deterministically (the free
  // endpoint is 429 from this VM anyway); shape is what this test proves.
  const noTranslate = async (texts) => ({
    translations: texts.map(() => null),
    status: 'unavailable',
    error: 'test-local: bỏ qua bước dịch (không gọi đầu dịch thật).',
  });
  const fixtureBuilder = () =>
    buildLessonFromFetched(
      {
        videoId: 'mKPRQF70PvA',
        title: 'Easy N5 Japanese Podcast',
        durationSec: 62,
        source: 'auto',
        json3,
      },
      { translate: noTranslate }
    );

  // Server under test: fixture builder (no live network).
  const app = createApp(fixtureBuilder);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. /health
    const health = await (await fetch(`${base}/health`)).json();
    check('GET /health -> { ok: true }', health && health.ok === true, JSON.stringify(health));

    // 2. Lesson shape via the endpoint (fixture).
    const rssBefore = rssMB();
    const t0 = Date.now();
    const r = await post(base, { videoId: 'mKPRQF70PvA' });
    const ms = Date.now() - t0;
    const lesson = r.json;
    check('POST /makeLesson -> HTTP 200', r.status === 200, `status=${r.status}`);
    check(
      'lesson.videoId = mKPRQF70PvA',
      lesson && lesson.videoId === 'mKPRQF70PvA',
      lesson && lesson.videoId
    );
    const lines = (lesson && lesson.lines) || [];
    check('lesson has 29 lines', lines.length === 29, `lines=${lines.length}`);
    const allShaped = lines.every(
      (l) =>
        typeof l.jp === 'string' && l.jp.length > 0 &&
        typeof l.reading === 'string' && l.reading.length > 0 &&
        typeof l.romaji === 'string' && l.romaji.length > 0 &&
        Array.isArray(l.tokens) && l.tokens.length > 0
    );
    check('every line has jp/reading/romaji/tokens', allShaped, `sample: ${JSON.stringify(lines[0]).slice(0, 160)}`);
    check(
      'meta.translationStatus present',
      lesson && lesson.meta && typeof lesson.meta.translationStatus === 'string',
      lesson && lesson.meta && lesson.meta.translationStatus
    );
    check(
      'meta.lineCount = 29',
      lesson && lesson.meta && lesson.meta.lineCount === 29,
      lesson && lesson.meta && `lineCount=${lesson.meta.lineCount}`
    );
    console.log(`  (lesson built in ${ms} ms, RSS ${rssBefore.toFixed(0)} -> ${rssMB().toFixed(0)} MB)`);
    const peak = peakRssMB();
    console.log(`  peak RSS (VmHWM) so far: ${peak !== null ? peak.toFixed(0) + ' MB' : 'n/a (not Linux)'}`);
    if (peak !== null) {
      check('peak RSS under Render free 512 MB', peak < 512, `peak=${peak.toFixed(0)} MB`);
    }

    // 3-4. Error paths through the REAL builder (no network needed:
    // VideoIdError is thrown before any fetch).
    const { buildLessonFree } = require('../functions/src/pipeline');
    const realApp = createApp(buildLessonFree);
    const realServer = await new Promise((resolve) => {
      const s = realApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const realBase = `http://127.0.0.1:${realServer.address().port}`;
    try {
      const bad = await post(realBase, { url: 'https://example.com/not-a-video' });
      check(
        'real builder: bad link -> HTTP 400 + Vietnamese message',
        bad.status === 400 && bad.json && typeof bad.json.error === 'string' && bad.json.error.length > 0,
        `status=${bad.status}, error=${bad.json && bad.json.error}`
      );
      const empty = await post(realBase, {});
      check(
        'real builder: empty body -> HTTP 400',
        empty.status === 400 && empty.json && typeof empty.json.error === 'string',
        `status=${empty.status}, error=${empty.json && empty.json.error}`
      );
    } finally {
      await new Promise((resolve) => realServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n== Summary ==\n  FAIL: ${failures}`);
  if (failures > 0) process.exit(1);
  console.log('\nNOT tested live here (YouTube 429 from this VM):');
  console.log('  - Real caption fetch for mKPRQF70PvA from Render IP.');
  console.log('  - Real free-translate endpoint from Render IP.');
}

main().catch((err) => {
  console.error('test-local crashed:', err);
  process.exit(1);
});
