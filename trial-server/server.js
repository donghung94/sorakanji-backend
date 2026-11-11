'use strict';
/**
 * trial-server — Render free tier, ONLY the makeLesson function.
 *
 * Purpose: trial host for "user pastes a YouTube link -> shadowing lesson"
 * after Firebase deploys were blocked (project donghung-3208d has no billing
 * account; Google now requires billing for ANY Cloud Functions deploy).
 * This server is NOT the whole app and NOT Firebase — it reuses the exact
 * same pipeline (../functions/src/pipeline.js, buildLessonFree) that the
 * Firebase function would have run. Firebase code is untouched.
 *
 * Endpoints:
 *   GET  /health     -> { ok: true }
 *   POST /makeLesson -> { url } or { videoId } -> lesson JSON
 *                      (same shape as the Firebase callable returns)
 *   - Bad link / video with no Japanese captions -> HTTP 400 + the
 *     pipeline's Vietnamese message. No lesson is ever invented.
 *   - Free-translation failure -> the pipeline still returns the lesson
 *     with vi: null + meta.translationStatus ('partial' | 'unavailable');
 *     the lesson is passed through as-is.
 *
 * CORS is wide open (*) so the static PWA on githack can call this later.
 * No auth on this trial server — it is a throwaway test host.
 *
 * Memory note: kuromoji builds its tokenizer on first use (~1 s, ~400 MB
 * RSS). Render free gives 512 MB, so the first lesson request is the
 * tightest moment; the tokenizer instance is cached in module scope after
 * that. See test-local.js for the measured peak RSS.
 */
const express = require('express');
const { buildLessonFree } = require('../functions/src/pipeline');
const { VideoIdError } = require('../functions/src/videoId');
const { CaptionError } = require('../functions/src/captions');

/**
 * Build the Express app. `buildLesson` is injectable so tests can run the
 * HTTP endpoint against fixture data without live YouTube access;
 * production always uses buildLessonFree.
 */
function createApp(buildLesson) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // CORS open (trial host; the PWA on githack calls cross-origin).
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.post('/makeLesson', async (req, res) => {
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const lesson = await buildLesson({ url: input.url, videoId: input.videoId });
      res.json(lesson);
    } catch (err) {
      if (err instanceof VideoIdError || err instanceof CaptionError) {
        // Bad link / unavailable video / no Japanese captions: client error,
        // message is the pipeline's own Vietnamese text.
        return res.status(400).json({ error: err.message });
      }
      console.error('[makeLesson]', err);
      return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý video. Thử lại sau ít phút.' });
    }
  });

  // Malformed JSON body -> JSON error instead of Express's default HTML page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Body gửi lên không phải JSON hợp lệ.' });
    }
    console.error('[server]', err);
    return res.status(500).json({ error: 'Lỗi máy chủ. Thử lại sau ít phút.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp(buildLessonFree);
  app.listen(port, () => {
    console.log(`trial-server listening on :${port}`);
  });
}

module.exports = { createApp };
