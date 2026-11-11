#!/usr/bin/env node
'use strict';
/**
 * make-lesson.js — ready-to-use tool: give it a YouTube link, get a lesson.
 *
 *   node tools/make-lesson.js <youtube-url-or-id> [options]
 *
 * What it does (same pipeline as the Firebase backend, run locally):
 *   1. fetch the video's Japanese subtitles (manual preferred, else auto)
 *   2. translate each line to Vietnamese (Google Translate — needs GCP
 *      credentials; without them the lines stay vi: null for hand translation)
 *   3. add furigana + romaji (kuromoji, local)
 *   4. write <videoId>.lesson.json (app format) + <videoId>.review.md
 *
 * THE REVIEW STEP IS MANDATORY: auto subtitles contain recognition errors
 * and machine translation is imperfect. Never put a lesson into the app
 * without hand-checking every line the review file flags. (Quy tắc: không
 * dạy sai — nội dung chưa soát kỹ không được đưa cho người học.)
 *
 * Options:
 *   --out <dir>            output directory (default: ./out)
 *   --subs <file.json3>    use a local timedtext json3 file instead of a
 *                          live YouTube fetch (when YouTube blocks the
 *                          machine — e.g. datacenter IPs get HTTP 429).
 *                          Download it with e.g.:
 *                            yt-dlp --write-auto-subs --sub-langs ja \
 *                              --sub-format json3 --skip-download <url>
 *   --title "..."          video title (with --subs; otherwise from YouTube)
 *   --duration <sec>       video length in seconds (with --subs)
 *   --source manual|auto   subtitle source (with --subs; default: auto)
 *   --no-translate         skip machine translation (vi: null — translate by hand)
 *   --stub-translate       use the clearly-marked stub translator (testing only)
 *   --help
 *
 * Examples:
 *   node tools/make-lesson.js https://www.youtube.com/shorts/mKPRQF70PvA
 *   node tools/make-lesson.js mKPRQF70PvA --subs ./mKPRQF70PvA.ja.json3 --no-translate
 *
 * Requirements: run from the repo root; Node 20; `functions/node_modules`
 * installed (cd functions && npm install).
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'functions', 'src');
const { extractVideoId } = require(path.join(SRC, 'videoId'));
const { fetchJapaneseCaptions } = require(path.join(SRC, 'captions'));
const { buildLesson, buildLessonFromFetched } = require(path.join(SRC, 'pipeline'));

function usage() {
  console.log(`Usage: node tools/make-lesson.js <youtube-url-or-id> [options]

Options:
  --out <dir>            output directory (default: ./out)
  --subs <file.json3>    use a local timedtext json3 file instead of live fetch
  --title "..."          video title (with --subs)
  --duration <sec>       video length in seconds (with --subs)
  --source manual|auto   subtitle source (with --subs; default: auto)
  --no-translate         skip machine translation (vi: null)
  --stub-translate       use the clearly-marked stub translator (testing only)
  --help                 show this help`);
}

function parseArgs(argv) {
  const opts = { out: './out', source: 'auto', title: '', durationSec: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--subs') opts.subs = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--duration') opts.durationSec = Number(argv[++i]);
    else if (a === '--source') opts.source = argv[++i];
    else if (a === '--no-translate') opts.noTranslate = true;
    else if (a === '--stub-translate') opts.stubTranslate = true;
    else if (a.startsWith('--')) throw new Error(`Tùy chọn không biết: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error('Cần đúng 1 link hoặc ID video.');
  opts.input = positional[0];
  if (!['manual', 'auto'].includes(opts.source)) throw new Error('--source phải là manual hoặc auto.');
  return opts;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Lines that need hand review, with reasons (Vietnamese). */
function flagLine(line, source) {
  const flags = [];
  if (source === 'auto') flags.push('phụ đề tự động — có thể sai nhận dạng');
  if (line.jp.includes('…')) flags.push('câu này phụ đề gốc nghe chưa rõ (dấu …)');
  if (line.jp.replace(/[。、？！…\s]/g, '').length <= 2) flags.push('mảnh câu quá ngắn — kiểm tra có phải mảnh vỡ của sub tự động không');
  if (line.furiganaWarning) flags.push(`furigana: ${line.furiganaWarning}`);
  if (!line.vi) flags.push('chưa có bản dịch tiếng Việt');
  else if (line.vi.startsWith('[DỊCH MÁY - STUB]')) flags.push('bản dịch STUB (test) — chưa phải dịch thật');
  return flags;
}

function buildReview(lesson, videoId) {
  const { title, durationSec, source, lines, meta } = lesson;
  const flagged = lines
    .map((l, i) => ({ i, line: l, flags: flagLine(l, source) }))
    .filter((x) => x.flags.length > 0);
  const L = [];
  L.push(`# Soát bài học video — ${title || videoId} (${videoId})`);
  L.push('');
  L.push(`- Nguồn phụ đề: ${source === 'auto' ? 'tự động (YouTube)' : 'do người đăng tải lên'}${source === 'auto' ? ' — **CẦN SOÁT TAY TỪNG CÂU trước khi đưa vào app**' : ''}`);
  L.push(`- Thời lượng: ${durationSec ? `${durationSec}s` : 'không rõ'} | Số câu: ${lines.length}`);
  L.push(`- Dịch máy: ${meta.translationAvailable ? `${lines.filter((l) => l.vi).length}/${lines.length} câu` : 'CHƯA DỊCH — dịch tay hoặc chạy lại khi có credentials Google Translate'}`);
  L.push(`- Furigana: kuromoji (máy) + bảng số đếm`);
  if (meta.warnings.length > 0) {
    L.push(`- Cảnh báo: ${meta.warnings.join(' | ')}`);
  }
  L.push('');
  L.push(`## Câu cần soát kỹ (${flagged.length}/${lines.length} câu)`);
  L.push('');
  if (flagged.length === 0) {
    L.push('Không có câu nào bị đánh dấu — vẫn nên đọc lướt toàn bộ một lượt.');
  } else {
    for (const { i, line, flags } of flagged) {
      L.push(`- [ ] ${fmtTime(line.start)} — ${line.jp}`);
      L.push(`      Lý do: ${flags.join('; ')}`);
      if (line.vi) L.push(`      Dịch máy: ${line.vi}`);
    }
  }
  L.push('');
  L.push('## Toàn bộ câu (đọc lướt + tick khi đã soát)');
  L.push('');
  for (const line of lines) {
    const vi = line.vi ? ` — ${line.vi}` : ' — [CHƯA DỊCH]';
    L.push(`- [ ] ${fmtTime(line.start)} ${line.jp} (${line.reading || '?'} / ${line.romaji || '?'}${vi})`);
  }
  L.push('');
  L.push('## Các bước tiếp theo');
  L.push('');
  L.push('1. Soát từng câu trong file này: sửa nghĩa sai, sửa lỗi nhận dạng của sub tự động, sửa dịch Việt, kiểm tra furigana/romaji.');
  L.push('2. Sửa trực tiếp trong file `.lesson.json` tương ứng (giữ nguyên `start`/`end`, chỉ sửa `jp`/`reading`/`romaji`/`vi`).');
  L.push('3. Đưa file `.lesson.json` đã soát cho Muse để nhúng vào mục Shadowing video trong app (player 4 tab đã có sẵn).');
  L.push('4. Xóa file `.review.md` này sau khi soát xong — không đưa vào app.');
  L.push('');
  return L.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Lỗi: ${err.message}\n`);
    usage();
    process.exit(1);
  }
  if (opts.help) {
    usage();
    return;
  }
  if (opts.stubTranslate) process.env.SORAKANJI_TRANSLATE_STUB = '1';
  if (opts.noTranslate) process.env.SORAKANJI_SKIP_TRANSLATE = '1';

  const videoId = extractVideoId(opts.input);
  console.log(`Video: ${videoId}`);

  let lesson;
  if (opts.subs) {
    const json3 = JSON.parse(fs.readFileSync(opts.subs, 'utf8'));
    lesson = await buildLessonFromFetched({
      videoId,
      title: opts.title || videoId,
      durationSec: opts.durationSec,
      source: opts.source,
      json3,
    });
    console.log(`Dùng file phụ đề local: ${opts.subs} (source=${opts.source})`);
  } else {
    lesson = await buildLesson({ videoId });
    console.log(`Lấy phụ đề từ YouTube: title="${lesson.title}", source=${lesson.source}`);
  }

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const lessonPath = path.join(outDir, `${videoId}.lesson.json`);
  const reviewPath = path.join(outDir, `${videoId}.review.md`);
  fs.writeFileSync(lessonPath, `${JSON.stringify(lesson, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reviewPath, `${buildReview(lesson, videoId)}\n`, 'utf8');

  const flaggedCount = lesson.lines.filter(
    (l) => flagLine(l, lesson.source).length > 0
  ).length;
  console.log(`\nXong: ${lesson.lines.length} câu, ${flaggedCount} câu cần soát kỹ.`);
  console.log(`  Bài học: ${lessonPath}`);
  console.log(`  Bản soát: ${reviewPath}`);
  console.log('  NHỚ: soát tay các câu bị đánh dấu trong bản soát trước khi đưa vào app.');
}

main().catch((err) => {
  console.error(`\nLỗi: ${err.message || err}`);
  if (err.code) console.error(`Mã lỗi: ${err.code}`);
  process.exit(1);
});
