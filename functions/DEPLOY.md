# DEPLOY.md — deploy the SoraKanji subtitle backend

Deploy target: Firebase project **`donghung-3208d`** (the existing project,
shared with the Tokutei app). Two functions (same lesson JSON schema):
- `makeLessonFromVideo` — **paid path** (gen 2): Cloud Translation API,
  needs Blaze + Translation API enabled (steps 1–7 below).
- `makeLessonFromVideoFree` — **FREE path** (gen 1): unofficial Google
  Translate endpoint, no billing, runs on the Spark plan. Temporary — see
  "Đường FREE (tạm thời)" below. Deploy it with
  `firebase deploy --only functions:makeLessonFromVideoFree`.

**Only the user can do the steps marked 👤** (Google login, billing).
Everything else is already done: the code is complete and locally tested.

## 0. What you need

- Node.js 20 (check: `node --version` → v20.x)
- Firebase CLI: `npm install -g firebase-tools`
- A Google account with Owner/Editor access to project `donghung-3208d`
- Billing enabled on the project (Blaze plan — required for gen-2 Functions)

## 1. 👤 Log in to Firebase

```bash
firebase login
# opens the browser — sign in with the Google account that owns donghung-3208d
```

## 2. 👤 Upgrade the project to Blaze (pay-as-you-go)

Cloud Functions **2nd gen requires the Blaze plan**. The free tier still
applies (2M invocations/mo, 400k GB-seconds), so at the expected volume the
bill stays ~0đ — but the plan must be Blaze, not Spark.

- Firebase console → project `donghung-3208d` → bottom-left "Upgrade"
  (or: https://console.firebase.google.com/project/donghung-3208d/usage/details)
- Attach a card. Set a budget alert while there (Billing → Budgets & alerts,
  e.g. 200.000đ/tháng) so a runaway bill is impossible.

## 3. 👤 Enable the Cloud Translation API

The function translates with Google Cloud Translation (v2). It needs the API
enabled on the project (no key is stored in code — the function's service
account is used automatically).

```bash
gcloud services enable translate.googleapis.com --project=donghung-3208d
# or in the console:
# https://console.cloud.google.com/apis/library/translate.googleapis.com?project=donghung-3208d
#  -> "Enable"
```

No extra IAM step is needed: the default App Engine service account used by
Cloud Functions has the Editor role, which can call the Translation API once
it is enabled and billing is on.

## 4. Select the project and install dependencies

```bash
cd sorakanji-backend
firebase use donghung-3208d        # .firebaserc already points here
cd functions
npm install --legacy-peer-deps     # installs firebase-functions, firebase-admin,
                                   # @google-cloud/translate, kuromoji (~124 MB, dict included)
```

> `--legacy-peer-deps` is needed because the project pins
> `firebase-functions@^5.1.0` (last version with the v1 API for the gen-1
> free function) while `firebase-admin` is v13, outside v5's peer range
> (^11 || ^12). Verified 2026-11-11: v5 + admin 13 load and define both
> functions fine locally; admin is only used for `initializeApp()`.

## 5. 👤 Deploy

```bash
cd sorakanji-backend
firebase deploy --only functions
```

Expected output: `✔ Deploy complete!` with
`Function URL (makeLessonFromVideo): ...` — note: it is a **callable**
function, so there is no public HTTP URL to open in a browser; the app
calls it with the Firebase SDK (see README.md).

Deploy takes a few minutes the first time (the kuromoji dictionary is
~40 MB). If the deploy fails with a quota/permission error, run
`firebase functions:log --only makeLessonFromVideo` and check the message.

## 6. Verify (after deploy)

Option A — Firebase console:
- console.firebase.google.com → Functions → `makeLessonFromVideo` → "Test"
  tab (or the "Testing" panel) → run with
  `{"url": "https://www.youtube.com/shorts/mKPRQF70PvA"}`.
- Expect a lesson JSON with ~29 lines, `source: "auto"`, each line having
  `jp / reading / romaji / vi / viAuto: true`.

Option B — from the app (after wiring the call in, see README.md):
paste the same Shorts link and check the lesson renders in the 4-tab player.

Option C — logs:
```bash
firebase functions:log --only makeLessonFromVideo
```

## Đường FREE (tạm thời) — `makeLessonFromVideoFree` (gen 1, gói Spark)

Dành cho lúc này: user tự dán link trong app mà **không cần nâng Blaze,
không tốn tiền, không bật Translation API**. Function gen 1 dùng lại toàn
bộ pipeline (lấy caption → gộp câu → furigana/romaji bằng kuromoji), chỉ
khác bước dịch: dùng đầu dịch Google **không chính thức**
(`translate.googleapis.com/translate_a/single?client=gtx`).

### Các bước (chỉ cần 👤 login + deploy)

```bash
firebase login                     # bước 1 ở trên (nếu chưa login)
cd sorakanji-backend/functions
npm install --legacy-peer-deps     # bước 4 ở trên
firebase deploy --only functions:makeLessonFromVideoFree
```

⚠️ **Deploy đúng tên function như trên.** Đừng chạy
`firebase deploy --only functions` trên gói Spark: lệnh đó deploy cả
function gen 2 `makeLessonFromVideo` và sẽ fail với "Blaze plan required".

### Kiểm chứng sau deploy (bắt buộc — 2 điểm chưa chứng minh được)

1. **Dịch miễn phí có chạy từ IP của Functions không?**
   - Console → Functions → `makeLessonFromVideoFree` → tab Test, chạy với
     `{"url": "https://www.youtube.com/shorts/mKPRQF70PvA"}`.
   - Kỳ vọng: lesson JSON ~29 câu, mỗi câu có `jp / reading / romaji / vi`.
   - Nếu `meta.translationStatus` = `"unavailable"` và
     `meta.translationError` = "Google đang chặn dịch tự động…" → đầu dịch
     đang bị chặn (HTTP 429) từ IP của Functions lúc đó. Thử lại sau vài
     phút; nếu vẫn chặn thì đường free tạm thời không dùng được.
   - `"partial"` = một phần câu dịch được, phần còn lại `vi: null` (app
     hiển thị nút "thử dịch lại" — không bịa bản dịch, không giấu lỗi).
2. **Lấy caption từ gói Spark có được không?**
   - Gói Spark chỉ cho gọi ra ngoài tới dịch vụ của Google.
     `translate.googleapis.com` là tên miền googleapis.com nên qua được,
     nhưng bước lấy caption gọi tới `youtube.com` — **chưa kiểm chứng**
     Spark có cho qua hay không. Nếu test ở trên fail ngay từ bước lấy
     caption (`FETCH_FAILED` / `unavailable` trong log, xem bằng
     `firebase functions:log --only makeLessonFromVideoFree`), thì đường
     free không chạy được trên Spark. Lúc đó chỉ còn 2 lựa chọn: nâng
     Blaze để dùng đường trả phí, hoặc quay lại làm tay qua tool local
     (`tools/make-lesson.js`).

### Rủi ro cần biết (đường free là tạm thời)

- Đầu dịch miễn phí không phải API chính thức: Google chặn 429 bất cứ lúc
  nào, không có SLA. Đã kiểm chứng 2026-11-11: từ IP máy dev, câu đầu
  dịch được, 2 câu sau chặn ngay, chờ 20 giây gửi lại vẫn 429.
- Khi nào deploy đường trả phí (Blaze + Translation API) thì đổi app sang
  gọi `makeLessonFromVideo` — cùng schema lesson JSON nên app không cần
  sửa gì ngoài tên function.
- Lần deploy đầu vẫn chậm (từ điển kuromoji ~40 MB). Log:
  `firebase functions:log --only makeLessonFromVideoFree`.
- Xóa function (nếu cần):
  `firebase functions:delete makeLessonFromVideoFree --region asia-northeast1`

## Wire the app (next step, separate job)

In the app (sorakanji-phone-mockup), add a "Dán link YouTube" entry in the
video Shadowing section that calls the function and opens the returned
lesson JSON in the existing 4-tab player. **Do not ship auto-sub lessons
without the review step**: show the `source: "auto"` + `viAuto` badges and
the `meta.warnings` before the lesson is taught. For the free path, also
show `meta.translationStatus`: `"partial"` / `"unavailable"` means some or
all lines have `vi: null` — offer a "thử dịch lại" retry instead of
showing a made-up translation. The paid-tier gate
(`request.auth` / `context.auth` + `users/{uid}.premium`) is marked TODO in
`index.js` — enforce it when premium launches (the feature belongs to the
paid tier per the 2026-11-05 decision). While the free path is in use, the
app calls `makeLessonFromVideoFree`; switching to the paid path later is
just a function-name change (same lesson JSON schema).

## Rollback / update

- Re-deploy after any code change: `firebase deploy --only functions`
  (paid path) or `firebase deploy --only functions:makeLessonFromVideoFree`
  (free path on Spark).
- Delete the function (if ever needed):
  `firebase functions:delete makeLessonFromVideo --region asia-northeast1`
  (free: `firebase functions:delete makeLessonFromVideoFree --region asia-northeast1`)
- The function is stateless; nothing is stored in Firestore by it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Error: Blaze plan required` | Do step 2 (upgrade to Blaze). |
| `Translation API has not been used / is disabled` | Do step 3 (enable the API). |
| `PERMISSION_DENIED` from Translate | Billing not enabled, or the API not enabled — redo steps 2–3. |
| Deploy timeout / `memory limit` | First deploy is slow (40 MB dict); re-run the deploy command. |
| Function returns `VIDEO_UNAVAILABLE` for a public video | YouTube bot-check on the function's egress IP (rare from Google Cloud). Retry; if persistent, the timedtext endpoints are being throttled — see README "Known limits". |
| `NO_CAPTIONS` | The video genuinely has no Japanese captions. Whisper (phase 2) is not built — see README. |
| Free path returns `translationStatus: "unavailable"` + "Google đang chặn dịch tự động" | Free translate endpoint is rate-limiting (HTTP 429) from Functions IPs right now. Retry in a few minutes; the lesson still has jp + furigana. If it persists, the free path is unusable for now — use the paid path or the local tool. |
| Free path fails at caption fetch (`FETCH_FAILED` / `unavailable`) on Spark | Spark egress may not allow `youtube.com`. See "Đường FREE" check 2 — the free path cannot run on Spark in that case; use Blaze (paid path) or the local tool. |
