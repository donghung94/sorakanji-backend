# SoraKanji backend

Firebase Functions backend + local lesson-making tool for SoraKanji
(project `donghung-3208d`, shared with the Tokutei app — never touches
Tokutei collections or rules).

**Status: code complete + locally tested. NOT deployed yet.**

## Two ways to make a lesson from a YouTube link

### 1. The tool (use this now — no deploy needed)

Give it a link, get a lesson JSON + a review checklist:

```bash
node tools/make-lesson.js https://www.youtube.com/shorts/mKPRQF70PvA
# -> out/mKPRQF70PvA.lesson.json  (app format, ready to embed)
# -> out/mKPRQF70PvA.review.md   (hand-review checklist — MANDATORY step)
```

If YouTube blocks the machine (datacenter IPs get HTTP 429), download the
subtitle file first and pass it in:

```bash
yt-dlp --write-auto-subs --sub-langs ja --sub-format json3 --skip-download <url>
node tools/make-lesson.js <url> --subs ./<id>.ja.json3 --no-translate
```

**Review rule (non-negotiable):** auto subtitles contain recognition errors
and machine translation is imperfect. Hand-check every line the review file
flags before the lesson goes into the app. See `tools/make-lesson.js --help`.

### 2. The Firebase Functions (for the in-app paste-link feature)

Two callables, same pipeline and same lesson JSON schema (region
`asia-northeast1`):
- `makeLessonFromVideo` (gen 2, paid) — Cloud Translation API; needs Blaze
  + Translation API enabled.
- `makeLessonFromVideoFree` (gen 1, FREE, temporary) — unofficial free
  Google Translate endpoint; runs on the Spark plan, no billing. Deploy
  only it: `firebase deploy --only functions:makeLessonFromVideoFree`.

Deploy steps: `functions/DEPLOY.md`. App wiring + the paid-tier gate are
separate jobs (see `functions/README.md`).

## Layout

```
sorakanji-backend/
  firebase.json / .firebaserc   project donghung-3208d
  tools/
    make-lesson.js              CLI: link -> lesson JSON + review checklist
  functions/
    index.js                    onCall wrappers (makeLessonFromVideo gen 2,
                                makeLessonFromVideoFree gen 1)
    src/                        videoId, captions, parse, romaji, furigana,
                                translate (paid), translate-free, pipeline,
                                whisper (phase-2 stub)
    test/                       local-test.js + free-test.js (`npm test`) + fixtures
    README.md                   architecture, schema, costs, known limits
    DEPLOY.md                   exact deploy steps
```

## Test status (2026-11-11, this machine)

`cd functions && npm test` → **36 PASS, 0 FAIL, 3 BLOCKED**
(22 local-test + 14 free-test; the 3 BLOCKED are live YouTube fetches in
local-test step 1). The free translate endpoint is tested with a mocked
fetch only — the real endpoint is rate-limited from this VM (verified
2026-11-11: HTTP 429 after the first sentence), so a live check from
Cloud Functions IPs is a post-deploy step (DEPLOY.md "Đường FREE").
The 3 BLOCKED are live YouTube fetches (step 1) — YouTube answers this VM's
datacenter IP with HTTP 429 + a sign-in challenge. Real Google Translate is
also untested here (no GCP credentials — a clearly-marked stub is used
instead). Everything else is tested for real on fixtures, including the
full pipeline on the Shorts `mKPRQF70PvA` (19/23 lines match the known
corrected transcript; the 4 misses are exactly the 4 known raw auto-sub
errors, which the pipeline surfaces instead of silently fixing).
