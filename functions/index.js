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
 *        gen 2 also accepts { videoId, captions, title?, captionSource? } —
 *        client-supplied json3 from the native app (fetched on the user's
 *        phone); skips the server-side caption fetch + Gemini entirely.
 *        Invalid captions -> invalid-argument (400).
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
const crypto = require('crypto');
const functionsV1 = require('firebase-functions/v1');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { buildLesson, buildLessonFree, InputError } = require('./src/pipeline');
const { VideoIdError } = require('./src/videoId');
const { CaptionError } = require('./src/captions');

// Gemini API key (Secret Manager) — powers the Gemini transcription fallback
// in src/gemini.js. Set with: firebase functions:secrets:set GEMINI_API_KEY
// Without it the fallback is skipped and caption failures surface as before.
const geminiApiKey = defineSecret('GEMINI_API_KEY');

// Activation secret (Secret Manager) — shared secret the email-watch cron
// sends when it has confirmed a bank transfer. Set with:
//   firebase functions:secrets:set PAY_ACTIVATION_SECRET
// Same value is kept in the repo-root .activation-secret (gitignored) for
// the cron. NEVER log this value.
const payActivationSecret = defineSecret('PAY_ACTIVATION_SECRET');

// SePay webhook key (Secret Manager) — API Key SePay sends as
// `Authorization: Apikey <key>` on every webhook delivery. Set with:
//   firebase functions:secrets:set SEPAY_WEBHOOK_KEY
// Same value is kept in the repo-root .sepay-webhook-key (gitignored) so
// the owner can paste it into the SePay dashboard webhook config.
// NEVER log this value.
const sepayWebhookKey = defineSecret('SEPAY_WEBHOOK_KEY');

admin.initializeApp();

/** Shared error mapping: pipeline errors -> callable HttpsError (both gens). */
function mapLessonError(err, logTag) {
  if (err instanceof VideoIdError || err instanceof InputError) {
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
    secrets: [geminiApiKey],
  },
  async (request) => {
    const data = request.data || {};
    // TODO (premium launch): enforce paid-tier gate here, e.g.
    //   if (!request.auth) throw new HttpsError('unauthenticated', 'Cần đăng nhập để dùng tính năng này.');
    //   const snap = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    //   if (!snap.data()?.premium) throw new HttpsError('permission-denied', 'Tính năng này thuộc gói Premium.');
    try {
      return await buildLesson({
        url: data.url,
        videoId: data.videoId,
        refresh: data.refresh,
        captions: data.captions,
        title: data.title,
        captionSource: data.captionSource,
      });
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
  .runWith({ memory: '1GB', timeoutSeconds: 300, minInstances: 0, maxInstances: 10, secrets: ['GEMINI_API_KEY'] })
  .https.onCall(async (data, context) => {
    const input = data || {};
    // TODO (premium launch): enforce paid-tier gate here, e.g.
    //   if (!context.auth) throw new functionsV1.https.HttpsError('unauthenticated', 'Cần đăng nhập để dùng tính năng này.');
    //   const snap = await admin.firestore().doc(`users/${context.auth.uid}`).get();
    //   if (!snap.data()?.premium) throw new functionsV1.https.HttpsError('permission-denied', 'Tính năng này thuộc gói Premium.');
    try {
      return await buildLessonFree({ url: input.url, videoId: input.videoId, refresh: input.refresh });
    } catch (err) {
      throw mapLessonError(err, 'makeLessonFromVideoFree');
    }
  });

// ---------------------------------------------------------------------------
// Shared order activation (used by activatePremium + sepayWebhook).
//
// Runs one Firestore transaction: flip a pending sk_orders/{code} doc to
// paid and grant premium at kanji_progress/{uid}.premium. Idempotent: an
// already-paid order returns 'already_paid' without touching anything.
//
// Returns { outcome, uid?, plan? } where outcome is one of:
//   'activated' | 'already_paid' | 'order_not_found' |
//   'amount_mismatch' | 'invalid_state'
// `extra` (optional) adds fields to the order update (e.g. SePay ids).
// Throws on Firestore errors (callers map to 500).
// ---------------------------------------------------------------------------
async function activateOrder(db, { code, amount, ref, date, extra }) {
  const orderRef = db.collection('sk_orders').doc(code);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return { outcome: 'order_not_found' };
    const order = snap.data();

    if (order.status === 'paid') {
      return { outcome: 'already_paid', uid: order.uid, plan: order.package };
    }
    if (order.status !== 'pending') {
      return { outcome: 'invalid_state' };
    }
    if (order.amount !== amount) {
      return { outcome: 'amount_mismatch' };
    }
    if (order.package !== 'year' && order.package !== 'lifetime') {
      return { outcome: 'invalid_state' };
    }
    if (typeof order.uid !== 'string' || !order.uid) {
      return { outcome: 'invalid_state' };
    }

    const now = admin.firestore.Timestamp.now();
    let until = null;
    if (order.package === 'year') {
      const untilDate = now.toDate();
      untilDate.setMonth(untilDate.getMonth() + 12);
      until = admin.firestore.Timestamp.fromDate(untilDate);
    }

    tx.update(orderRef, {
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      ref: ref ?? null,
      transferDate: date ?? null,
      ...(extra || {}),
    });
    // createdAt (added 2026-11-18, admin stats dashboard): stamp the account
    // creation time ONLY when this is the first time the progress doc is
    // created. The sync module only creates the doc when it does not exist,
    // so without this a user whose doc was first created here (Premium
    // activation before first sync) would never get createdAt. Existing
    // docs keep their createdAt untouched (merge + conditional write).
    const progressRef = db.collection('kanji_progress').doc(order.uid);
    const progressSnap = await tx.get(progressRef);
    const progressData = { premium: { plan: order.package, since: now, until } };
    if (!progressSnap.exists) {
      progressData.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    tx.set(progressRef, progressData, { merge: true });

    return { outcome: 'activated', uid: order.uid, plan: order.package };
  });
}

// ---------------------------------------------------------------------------
// activatePremium (gen 2, onRequest) — manual bank-transfer activation.
//
// The email-watch cron confirms a transfer in the MB Bank notification mail,
// then POSTs here. The web checkout (separate agent) creates the order doc
// first; this function only flips a pending order to paid and grants premium.
//
//   POST { secret, code, amount, ref, date }
//     secret — PAY_ACTIVATION_SECRET shared secret (never logged)
//     code   — order code, doc id in sk_orders ("SK" + 8 [A-Z0-9])
//     amount — VND actually received; must equal the order's amount
//     ref    — bank transaction reference (stored on the order)
//     date   — transfer date from the mail (stored on the order)
//
//   200 { ok:true, uid, plan }            — activated
//   200 { ok:true, alreadyPaid:true }     — order already paid (idempotent)
//   400 { error:"invalid_input" }         — bad code/amount
//   400 { error:"invalid_state" }         — order not pending/paid
//   400 { error:"amount_mismatch" }       — amount != order.amount (NOT activated)
//   401 { error:"unauthorized" }          — wrong/missing secret
//   404 { error:"order_not_found" }       — no such order
//   405 { error:"method_not_allowed" }    — non-POST
//
// Premium lands at kanji_progress/{uid}.premium = { plan, since, until }:
//   "year"     -> until = now + 12 months
//   "lifetime" -> until = null
// Order update + premium grant run in one Firestore transaction (atomic).
// Deploy: firebase deploy --only functions:activatePremium
// ---------------------------------------------------------------------------
exports.activatePremium = onRequest(
  {
    region: 'asia-northeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    minInstances: 0,
    maxInstances: 10,
    secrets: [payActivationSecret],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // --- secret check (timing-safe) -------------------------------------
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const expected = (payActivationSecret.value() || '').trim();
    const provided = typeof body.secret === 'string' ? body.secret : '';
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    const secretOk =
      expected.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!secretOk) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // --- input validation ------------------------------------------------
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const amount = body.amount;
    if (!code || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const ref = typeof body.ref === 'string' ? body.ref : null;
    const date = typeof body.date === 'string' ? body.date : null;

    const db = admin.firestore();

    try {
      const result = await activateOrder(db, { code, amount, ref, date });

      if (result.outcome === 'activated') {
        // eslint-disable-next-line no-console
        console.log('[activatePremium] activated', { code, uid: result.uid, plan: result.plan });
        res.status(200).json({ ok: true, uid: result.uid, plan: result.plan });
        return;
      }
      if (result.outcome === 'already_paid') {
        res.status(200).json({ ok: true, alreadyPaid: true });
        return;
      }
      if (result.outcome === 'order_not_found') {
        res.status(404).json({ error: 'order_not_found' });
        return;
      }
      if (result.outcome === 'amount_mismatch') {
        res.status(400).json({ error: 'amount_mismatch' });
        return;
      }
      res.status(400).json({ error: 'invalid_state' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[activatePremium] error', err);
      res.status(500).json({ error: 'internal' });
    }
  }
);

// ---------------------------------------------------------------------------
// sepayWebhook (gen 2, onRequest) — automatic activation via SePay.
//
// SePay watches the linked bank account and POSTs here on every matching
// transaction (webhook configured in the SePay dashboard: event "tiền vào",
// account = the linked VietinBank/MB account). This function extracts the
// order code from the transfer content, verifies the amount, and grants
// premium through the same transaction as activatePremium.
//
// Auth: API Key — SePay sends `Authorization: Apikey <SEPAY_WEBHOOK_KEY>`.
// The key is pasted into the webhook config in the SePay dashboard.
//
// SePay payload (JSON): { id, gateway, transactionDate, accountNumber,
//   subAccount, code, content, transferType ("in"|"out"), transferAmount,
//   accumulated, referenceCode }
//
// Response contract (SePay counts success ONLY on HTTP 200/201 with
// body {"success": true} within 30s; anything else is retried 3-5 times):
//   - auth failure            -> 401 { success:false } (misconfiguration)
//   - transferType != "in"    -> 200 { success:true, ignored } (no retry)
//   - no order code in memo   -> 200 { success:true, matched:false }
//   - order not found / amount mismatch / bad state
//                             -> 200 { success:true, matched:false, reason }
//     (returning 200 stops SePay retries for transfers that will never
//     match; unmatched transfers are logged for manual reconciliation)
//   - already paid            -> 200 { success:true, alreadyPaid:true }
//   - activated               -> 200 { success:true, uid, plan }
//   - Firestore error         -> 500 { success:false } (SePay retries)
//
// Order code: "SK" + 8 [A-Z0-9], found in `content` (e.g. "SEVQR SKM5DED3HR"
// for VietinBank, whose memos must start with SEVQR) or in SePay's `code`
// field when a payment-code structure is configured in SePay.
// Deploy: firebase deploy --only functions:sepayWebhook
// ---------------------------------------------------------------------------
const ORDER_CODE_RE = /SK[A-Z0-9]{8}/;

exports.sepayWebhook = onRequest(
  {
    region: 'asia-northeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    minInstances: 0,
    maxInstances: 10,
    secrets: [sepayWebhookKey],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'method_not_allowed' });
      return;
    }

    // --- API Key check (timing-safe) ------------------------------------
    const expected = (sepayWebhookKey.value() || '').trim();
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const provided = auth.startsWith('Apikey ') ? auth.slice('Apikey '.length).trim() : '';
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    const keyOk =
      expected.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!keyOk) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const logBase = {
      sepayId: body.id ?? null,
      gateway: body.gateway ?? null,
      transferType: body.transferType ?? null,
      amount: body.transferAmount ?? null,
      ref: body.referenceCode ?? null,
    };

    // Only incoming transfers can pay for an order.
    if (body.transferType !== 'in') {
      // eslint-disable-next-line no-console
      console.log('[sepayWebhook] ignored (not incoming)', logBase);
      res.status(200).json({ success: true, ignored: 'not_incoming' });
      return;
    }

    const amount = body.transferAmount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      // eslint-disable-next-line no-console
      console.log('[sepayWebhook] ignored (bad amount)', logBase);
      res.status(200).json({ success: true, matched: false, reason: 'bad_amount' });
      return;
    }

    // Order code: prefer SePay's extracted `code`, fall back to scanning
    // the raw memo (covers "SEVQR SK..." VietinBank memos).
    let code = '';
    const fromCode = typeof body.code === 'string' ? body.code.match(ORDER_CODE_RE) : null;
    const fromContent =
      !fromCode && typeof body.content === 'string' ? body.content.match(ORDER_CODE_RE) : null;
    if (fromCode) code = fromCode[0];
    else if (fromContent) code = fromContent[0];
    if (!code) {
      // eslint-disable-next-line no-console
      console.log('[sepayWebhook] no order code in memo', { ...logBase, content: body.content ?? null });
      res.status(200).json({ success: true, matched: false, reason: 'no_code' });
      return;
    }

    const ref =
      typeof body.referenceCode === 'string' && body.referenceCode ? body.referenceCode : null;
    const date =
      typeof body.transactionDate === 'string' && body.transactionDate ? body.transactionDate : null;
    const extra = {
      sepayId: body.id !== undefined && body.id !== null ? String(body.id) : null,
      sepayGateway: typeof body.gateway === 'string' && body.gateway ? body.gateway : null,
    };

    try {
      const result = await activateOrder(admin.firestore(), { code, amount, ref, date, extra });
      if (result.outcome === 'activated') {
        // eslint-disable-next-line no-console
        console.log('[sepayWebhook] activated', { ...logBase, code, uid: result.uid, plan: result.plan });
        res.status(200).json({ success: true, uid: result.uid, plan: result.plan });
        return;
      }
      if (result.outcome === 'already_paid') {
        res.status(200).json({ success: true, alreadyPaid: true });
        return;
      }
      // Unmatchable transfer: 200 so SePay does not retry; log for manual check.
      // eslint-disable-next-line no-console
      console.log('[sepayWebhook] unmatched', { ...logBase, code, reason: result.outcome });
      res.status(200).json({ success: true, matched: false, reason: result.outcome });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sepayWebhook] error', err);
      res.status(500).json({ success: false, error: 'internal' });
    }
  }
);

// ---------------------------------------------------------------------------
// logVisit (gen 2, onRequest) — anonymous visit counter for the admin stats
// dashboard (added 2026-11-18).
//
// Public, fire-and-forget: the app calls it once per app open (no auth, no
// UID/IP stored — only counters). Each call increments 3 counters in the
// single top-level collection `sk_stats` (Admin SDK, bypasses Firestore
// rules; clients can never write these docs):
//
//   sk_stats/visits-daily-{YYYY-MM-DD}   { count }   (day in JST)
//   sk_stats/visits-monthly-{YYYY-MM}    { count }   (month in JST)
//   sk_stats/visits-total                { count }   (all time)
//
// Day/month are JST (Asia/Tokyo), NOT server UTC. Always returns 200 — even
// on Firestore errors — so a counter failure never breaks the app.
// Deploy: firebase deploy --only functions:logVisit
// ---------------------------------------------------------------------------
const JST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

exports.logVisit = onRequest(
  {
    region: 'asia-northeast1',
    memory: '256MiB',
    timeoutSeconds: 30,
    minInstances: 0,
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      const [year, month, day] = JST_DATE.format(new Date()).split('-'); // en-CA => YYYY-MM-DD
      const db = admin.firestore();
      const inc = admin.firestore.FieldValue.increment(1);
      await Promise.all([
        db.doc(`sk_stats/visits-daily-${year}-${month}-${day}`).set({ count: inc }, { merge: true }),
        db.doc(`sk_stats/visits-monthly-${year}-${month}`).set({ count: inc }, { merge: true }),
        db.doc('sk_stats/visits-total').set({ count: inc }, { merge: true }),
      ]);
      res.status(200).json({ ok: true });
    } catch (err) {
      // Fire-and-forget: never fail the client call.
      // eslint-disable-next-line no-console
      console.error('[logVisit] error', err);
      res.status(200).json({ ok: false });
    }
  }
);
