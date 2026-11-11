# SoraKanji backend — paste a YouTube link, get a shadowing lesson

Firebase Functions backend for SoraKanji (project `donghung-3208d`, shared
with the Tokutei app — this backend never touches Tokutei collections or
rules). The app is a static PWA and cannot fetch YouTube subtitles from the
browser (CORS + YouTube bot-checks), so this server-side function does it.

**Status: code complete + locally tested. NOT deployed yet — see DEPLOY.md.**

## What it does

```
User pastes YouTube link in the app
  -> makeLessonFromVideo({ url })           (Firebase callable, region asia-northeast1)
  -> 1. extract video ID (watch / youtu.be / shorts / embed / live)
  -> 2. Innertube `player` -> captionTracks -> timedtext (fmt=json3)
        * prefers a manually-uploaded Japanese track, else auto Japanese (kind=asr)
        * records source: "manual" | "auto"
  -> 3. parse + merge fragments into sentence-like lines (split on 。？！, long pauses)
        * RAW subtitle text is kept — recognition errors are NOT silently fixed
  -> 4. Google Cloud Translation API (v2): ja -> vi, every line flagged viAuto: true
        * FREE variant: makeLessonFromVideoFree (gen 1, Spark plan) uses the
          unofficial free Google Translate endpoint instead — same pipeline,
          same schema; translation failure returns vi: null + translationStatus
          'partial'/'unavailable', never a fabricated translation (see DEPLOY.md)
  -> 5. kuromoji.js: furigana reading + Hepburn romaji per line
  -> lesson JSON (below) -> the app's video-lesson player
        (4 tabs: Phụ đề / Shadowing / Chính tả / Điền từ — same shape as the
        hand-made Shorts lesson v106)
```

## Lesson JSON (returned to the app)

```json
{
  "videoId": "mKPRQF70PvA",
  "title": "Easy N5 Japanese Podcast",
  "durationSec": 62,
  "source": "auto",
  "lines": [
    {
      "start": 0, "end": 1.8,
      "jp": "スイスで何をしましたか？",
      "reading": "スイスでなにをしましたか？",
      "romaji": "suisu de nani wo shimashita ka?",
      "vi": "Bạn đã làm gì ở Thụy Sĩ?",
      "viAuto": true,
      "tokens": [{ "surface": "スイス", "reading": "スイス", "pos": "名詞" }]
    }
  ],
  "meta": {
    "lineCount": 29,
    "translationAvailable": true,
    "translationStatus": "ok",
    "translationError": null,
    "warnings": ["Phụ đề tự động của YouTube — ... cần người soát lại ..."]
  }
}
```

Errors (Vietnamese messages, the app shows them as-is):
- `INVALID_VIDEO_ID` — link/ID sai định dạng
- `VIDEO_UNAVAILABLE` — video không phát được (xóa / riêng tư / giới hạn tuổi)
- `NO_CAPTIONS` — video không có phụ đề tiếng Nhật (cả manual lẫn auto)
- Translation failure is **non-fatal**: the lesson is still returned with
  `vi: null` and `meta.translationAvailable === false`.
  `meta.translationStatus` is `"ok"` | `"partial"` (some lines untranslated)
  | `"unavailable"` (none translated), with a Vietnamese
  `meta.translationError` the app can show ("thử lại sau vài phút").

## Calling it from the app

```js
import { getFunctions, httpsCallable } from "firebase/functions";
const fn = httpsCallable(getFunctions(undefined, "asia-northeast1"), "makeLessonFromVideo");
const { data } = await fn({ url: "https://www.youtube.com/shorts/mKPRQF70PvA" });
// data = lesson JSON above
```

## The local tool (no deploy needed)

Same pipeline as a CLI, for making lessons by hand right now:

```bash
node tools/make-lesson.js https://www.youtube.com/shorts/mKPRQF70PvA
# -> out/<videoId>.lesson.json + out/<videoId>.review.md
```

If YouTube blocks the machine, pass a downloaded subtitle file instead
(`--subs <file.json3>`, see `tools/make-lesson.js --help`). The review file
flags every uncertain line — hand-check it before the lesson goes into the
app (same rule as above: never teach unchecked content).

## Files

```
functions/
  index.js               Firebase gen-2 onCall wrapper (1 GiB, 300 s, asia-northeast1)
  package.json           Node 20, firebase-functions v2, firebase-admin,
                         @google-cloud/translate, kuromoji
  src/
    videoId.js           extract + validate YouTube video ID
    captions.js          Innertube player -> captionTracks -> timedtext json3
                         (+ env-gated yt-dlp fallback for local/manual runs)
    parse.js             json3 -> fragments -> sentence-like lines
    romaji.js            kana -> Hepburn romaji (no macrons; を=wo, は=wa, へ=e)
    furigana.js          kuromoji tokenizer -> reading + romaji + number table
    translate.js         Google Cloud Translation v2 (+ stub mode for local tests)
    pipeline.js          orchestration: fetch -> parse -> translate -> furigana
    whisper.js           PHASE 2 stub — NOT wired (see below)
  test/
    local-test.js        `npm test` — 7 steps, no credentials needed
    fixtures/            reconstructed raw auto-sub (mKPRQF70PvA), manual track,
                         mock player responses (track selection / no captions)
  README.md              this file
  DEPLOY.md              exact deploy steps (user does the login + billing)
```

## Furigana approach (evaluated)

**Chosen: kuromoji.js** (pure-JS MeCab port, dictionary bundled in
`node_modules/kuromoji/dict`, ~40 MB). No external service, no API key,
works offline inside the function. Tokenizer build ~1 s / ~400 MB RSS on
cold start, then cached across warm invocations — hence the 1 GiB function
memory. Accuracy on the test sentences: 11/11 lines exact (reading +
romaji), including `1ヶ月` -> `いっかげつ` / `ikkagetsu`, `実は` ->
`jitsu wa`, `スイス人` -> `suisu-jin`.

Alternatives considered:
- **kuroshiro** — same kuromoji engine underneath, heavier, no benefit.
- **wanakana** — kana conversion only; cannot read kanji, so no furigana.
- **MeCab as a service / Yahoo API** — external dependency + key + latency.

Number readings: kuromoji gives no reading for bare digits, so a small
best-effort counter table covers 1–10 + 11–99 + round hundreds/thousands
(ヶ月/日/人/年/月/時/分/円/個/本/冊/枚/歳/階/週間) and 19xx/20xx years.
Anything outside it falls back to digit-by-digit on'yomi and is flagged in
`meta.warnings` — it is a known limitation, not a silent guess.

Romaji style matches the lesson data the app already ships
(`suisu de nani wo shimashita ka?`, `tsukaimasen deshita`,
`suisu-jin na node`, `ikkagetsu gurai imashita.`).

## Costs (approximate — re-check at deploy time)

| Item | Cost |
|---|---|
| Cloud Functions gen 2 | Free tier: 2M invocations/mo, 400k GB-seconds, 200k CPU-seconds; then ~$0.40/M invocations + compute |
| Cloud Translation API | ~$20 / 1M characters (~1.000–1.500đ per 10-minute video) |
| Whisper (phase 2, not built) | ~$0.006 / minute of audio |

The project must be on the **Blaze (pay-as-you-go) plan** — gen-2 Functions
require it. Free-tier usage stays ~0đ at the expected volume.

## Known limits (do not hide these)

1. **Auto subtitles have recognition errors** (~4 errors / 1 minute on the
   test Shorts). The pipeline returns the raw text and flags
   `source: "auto"` + a warning. Auto-sub lessons must be human-reviewed
   before being taught — the app must show the "bản dịch máy / phụ đề tự
   động" badges (`viAuto`, `source`).
2. **YouTube bot-checks.** The caption fetch uses the same Innertube /
   timedtext endpoints as the well-known `youtube-transcript` libraries.
   From this dev VM the calls are blocked (HTTP 429 + sign-in challenge on
   the VM's datacenter IP; degraded `UNPLAYABLE` player responses). From
   Google Cloud Functions (Google egress) the same calls are expected to
   work — but YouTube can throttle them, and a 429 there surfaces as a
   `FETCH_FAILED` / `VIDEO_UNAVAILABLE` error, not a silent empty lesson.
   If YouTube hard-blocks the endpoints, the documented fallback is yt-dlp
   (local/manual runs only, `YTDLP_PATH` env var) or the official
   YouTube Data API (captions.download requires the channel owner's OAuth —
   not suitable for arbitrary videos).
3. **Videos without captions return an error, not a transcript.**
   Whisper transcription is **phase 2, deliberately not built**: it needs
   the audio file, and downloading YouTube audio violates YouTube's ToS.
   See `src/whisper.js` + the Phase 2 section below.
4. **Machine translation quality.** Google Translate is good for N5-level
   dialogue but not perfect; every `vi` is flagged `viAuto: true`.
5. **Furigana edge cases.** Rendaku, names, rare words and irregular
   counters (e.g. 20日 = はつか) can be wrong. The number table covers the
   common N5 cases; everything else is flagged in `meta.warnings`.

## Phase 2: Whisper (NOT built — decision gate)

For videos with no captions at all. What it would need:
- Explicit user decision to accept the ToS risk, OR scope limited to
  videos the user owns / has permission to process.
- `OPENAI_API_KEY` in Secret Manager (never in code).
- yt-dlp audio extraction -> private Cloud Storage bucket -> Whisper API
  (`verbose_json`, segment timestamps) -> same parse/translate/furigana
  pipeline.
- A hard per-day quota + paid-tier gate (real money per video).

## Testing

```bash
cd functions
npm test            # node test/local-test.js — no credentials needed
```

Results on this machine (2026-11-10): **22 PASS, 0 FAIL, 3 BLOCKED**.
The 3 BLOCKED are the live YouTube fetches (step 1) — blocked by YouTube
on this VM's IP (429 + sign-in challenge). Everything else is tested for
real on fixtures:

- Step 0: video ID extraction (8 valid URLs/IDs, 5 invalid rejected).
- Step 2: fixture pipeline on the real Shorts — merged lines match the
  known corrected transcript **19/23**; the 4 misses are exactly the 4
  known raw auto-sub errors (which the pipeline correctly surfaces, not
  fixes); all 6 key sentences present (raw or corrected form); the garbled
  0:50 line is kept, not dropped.
- Step 3: manual Japanese track preferred over auto Japanese.
- Step 4: no-captions video -> `NO_CAPTIONS` error with a Vietnamese message.
- Step 5: full pipeline end-to-end on fixtures (stub translator, clearly
  marked `[DỊCH MÁY - STUB]`).
- Step 6: furigana + romaji accuracy on 11 real sentences (all exact).
- Step 7: romaji converter units (14/14: sokuon, ん', long vowels, yōon).

**NOT tested here:** real Google Translate (no GCP credentials on this
machine — stub used instead), real YouTube fetch (blocked, see above),
Firebase deploy (needs the user's login + billing — see DEPLOY.md).

## Security

- No secrets in code. Translation uses Application Default Credentials
  (the function's service account); no API key is stored anywhere.
- The callable is currently open (free-launch phase). The paid-tier gate
  is marked `TODO` in `index.js`: check `request.auth` + a Firestore
  `users/{uid}.premium` flag before calling the pipeline.
- Never log video URLs, user IDs or lesson content beyond errors.
