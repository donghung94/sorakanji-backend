'use strict';
/**
 * index.js — Firebase Functions entry point.
 *
 * Two callable functions (same lesson JSON schema, different translate path):
 *
 *   makeLessonFromVideo     (gen 2) — paid path: Cloud Translation API,
 *                             needs Blaze + Translation API enabled (DEPLOY.md).
 *   makeLessonFromVideoFree (gen 1) — FREE path: unofficial Google Translate
 *                             web endpoint, no billing, runs on the Spark plan
 *                             (DEPLOY.md "Đường FREE"). Temporary: the free
 *                             endpoint is rate-limited aggressively and can
 *                             break at any time; a lesson is still returned
 *                             with vi: null + meta.translationStatus when
 *                             translation fails — never a fabricated translation.
 *
 * Both take:  call: { url } or { videoId }
 *        returns: lesson JSON { videoId, title, durationSec, source, lines, meta }
 *        throws (Vietnamese messages, the app shows them as-is):
 *     invalid-argument   — link/ID sai định dạng
 *     not-found          — video không phát được (xóa / riêng tư / giới hạn tuổi)
 *     failed-precondition— video không có phụ đề tiếng Nhật
 *     unavailable        — không gọi được YouTube / không dịch được (tạm thời)
 *     internal           — lỗi khác
 *
 * Auth / paid-tier gate (FUTURE, not enforced yet):
 *   request.auth (gen 2) / context.auth (gen 1) is available here. When the
 *   premium tier launches, gate these functions on auth + a Firestore
 *   `users/{uid}.premium` flag (or a per-user daily quota) BEFORE calling
 *   buildLesson / buildLessonFree. The functions are intentionally left open
 *   during the free-launch phase.
 *
 * Deploy: see DEPLOY.md. Region asia-northeast1 (Tokyo), 1 GiB memory
 * (kuromoji dictionary), 300 s timeout (translation of long videos).
 *
 * NOTE on firebase-functions version: this file uses BOTH the v2 API (gen 2)
 * and the v1 API (gen 1). firebase-functions v6 removed the v1 API, so the
 * project pins firebase-functions ^5.1.1 (last version with both). Do NOT
 * upgrade to v6 without replacing the gen-1 export.
 */

const admin = require('firebase-admin');
const functionsV1 = require('firebase-functions/v1');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { buildLesson, buildLessonFree } = require('./src/pipeline');
const { VideoIdError } = require('./src/videoId');
const { CaptionError } = require('./src/captions');

admin.initializeApp();

/** Shared error mapping: pipeline errors -> callable HttpsError (both gens). */
function mapLessonError(err, logTag) {
  if (err instanceof VideoIdError) {
    return new HttpsError('invalid-argument', err.message);
  }
  if (err instanceof CaptionError) {
    if (err.code === 'VIDEO_UNAVAILABLE') return new HttpsError('not-found', err.message);
    if (err.code === 'NO_CAPTIONS') return new HttpsError('failed-precondition', err.message);
    return new HttpsError('unavailable', err.message);
  }
  // eslint-disable-next-line no-console
  console.error(`[${logTag}]`, err);
  return new HttpsError('internal', 'Lỗi máy chủ khi xử lý video. Thử lại sau ít phút.');
}

exports.makeLessonFromVideo = onCall(
  {
    region: 'asia-northeast1',
    memory: '1GiB',
    timeoutSeconds: 300,
    minInstances: 0,
    maxInstances: 10,
  },
  async (request) => {
    const data = request.data || {};
    // TODO (premium launch): enforce paid-tier gate here, e.g.
    //   if (!request.auth) throw new HttpsError('unauthenticated', 'Cần đăng nhập để dùng tính năng này.');
    //   const snap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    //   if (!snap.data()?.premium) throw new HttpsError('permission-denied', 'Tính năng này thuộc gói Premium.');
    try {
      return await buildLesson({ url: data.url, videoId: data.videoId });
    } catch (err) {
      throw mapLessonError(err, 'makeLessonFromVideo');
    }
  }
);

// ---------------------------------------------------------------------------
// FREE path (gen 1 — runs on the Spark plan, no Blaze, no billing).
// Same pipeline as makeLessonFromVideo, but translation goes through the
// unofficial free Google Translate endpoint (src/translate-free.js).
// Deploy ONLY this function on Spark:
//   firebase deploy --only functions:makeLessonFromVideoFree
// (deploying the whole codebase on Spark fails: the gen-2 function above
// requires Blaze.) See DEPLOY.md "Đường FREE (tạm thời)".
// ---------------------------------------------------------------------------
exports.makeLessonFromVideoFree = functionsV1
  .region('asia-northeast1')
  .runWith({ memory: '1GB', timeoutSeconds: 300, minInstances: 0, maxInstances: 10 })
  .https.onCall(async (data, context) => {
    const input = data || {};
    // TODO (premium launch): enforce paid-tier gate here, e.g.
    //   if (!context.auth) throw new functionsV1.https.HttpsError('unauthenticated', 'Cần đăng nhập để dùng tính năng này.');
    //   const snap = await admin.firestore().doc(`users/${context.auth.uid}`).get();
    //   if (!snap.data()?.premium) throw new functionsV1.https.HttpsError('permission-denied', 'Tính năng này thuộc gói Premium.');
    try {
      return await buildLessonFree({ url: input.url, videoId: input.videoId });
    } catch (err) {
      throw mapLessonError(err, 'makeLessonFromVideoFree');
    }
  });
