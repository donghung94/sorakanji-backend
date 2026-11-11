'use strict';
/**
 * parse.js — turn YouTube timedtext JSON3 into sentence-like lesson lines.
 *
 * JSON3 shape (per event):
 *   { tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs, ... }], aAppend? }
 * Events with aAppend === 1 continue the previous event's text (auto-sub
 * correction of its own earlier fragment) — they must be appended, not
 * treated as a new fragment.
 *
 * Auto subtitles arrive as small fragments ("1" + "ヶ月ぐらいました。").
 * We merge fragments into sentence-like lines:
 *   - flush when the accumulated text ends with 。？！…
 *   - flush on a long pause (> PAUSE_GAP_S) between fragments
 *   - flush when the accumulated line gets too long (> MAX_LINE_SEC)
 * Each line keeps the start time of its first fragment (the app seeks to it).
 */

const PAUSE_GAP_S = 1.0;
const MAX_LINE_SEC = 12;
const SENTENCE_END_RE = /[。？！…]$/;
// Split a fragment's text at sentence boundaries (。？！…), keeping the
// punctuation. Auto-subs often pack "うん。だから…" or "いいですね。いいな。"
// into one fragment — the lesson needs them as separate lines.
const SENTENCE_SPLIT_RE = /[^。？！…]+[。？！…]*/g;

function json3ToFragments(json3) {
  if (!json3 || !Array.isArray(json3.events)) return [];
  const fragments = [];
  for (const ev of json3.events) {
    if (!ev || !Array.isArray(ev.segs) || ev.segs.length === 0) continue;
    const text = ev.segs
      .map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const dur = (ev.dDurationMs || 0) / 1000;
    if (ev.aAppend === 1 && fragments.length > 0) {
      // Auto-sub correction: append to the previous fragment.
      const prev = fragments[fragments.length - 1];
      prev.text += text;
      prev.end = Math.max(prev.end, start + dur);
    } else {
      // Split at sentence boundaries inside the fragment.
      const pieces = text.match(SENTENCE_SPLIT_RE) || [text];
      for (const piece of pieces) {
        fragments.push({ start, end: start + dur, text: piece.trim() });
      }
    }
  }
  return fragments;
}

/**
 * Merge fragments into lines. Returns [{ start, end, jp }].
 * Note: the text is the RAW subtitle text (auto-sub errors included).
 * Nothing here "fixes" recognition errors — that must stay a visible,
 * human-reviewable step, never a silent correction.
 */
function mergeFragments(fragments) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.jp.trim()) lines.push(cur);
    cur = null;
  };
  for (const f of fragments) {
    if (!cur) {
      cur = { start: f.start, end: f.end, jp: f.text };
      continue;
    }
    const gap = f.start - cur.end;
    const tooLong = f.end - cur.start > MAX_LINE_SEC;
    if (SENTENCE_END_RE.test(cur.jp) || gap > PAUSE_GAP_S || tooLong) {
      flush();
      cur = { start: f.start, end: f.end, jp: f.text };
    } else {
      cur.jp += f.text;
      cur.end = f.end;
    }
  }
  flush();
  return lines;
}

function parseJson3(json3) {
  return mergeFragments(json3ToFragments(json3));
}

module.exports = { json3ToFragments, mergeFragments, parseJson3, PAUSE_GAP_S, MAX_LINE_SEC };
