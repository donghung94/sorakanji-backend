'use strict';
/**
 * videoId.js — extract + validate a YouTube video ID from a raw ID or URL.
 *
 * Accepted inputs:
 *   - plain 11-char ID:            dQw4w9WgXcQ
 *   - watch URL:                   https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *   - short URL:                   https://youtu.be/dQw4w9WgXcQ
 *   - Shorts / embed / live:      https://www.youtube.com/shorts/dQw4w9WgXcQ
 *                                  https://www.youtube.com/embed/dQw4w9WgXcQ
 *                                  https://www.youtube.com/live/dQw4w9WgXcQ
 *   - music.youtube.com watch URLs
 * Extra query params / timestamps are ignored.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

class VideoIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VideoIdError';
    this.code = 'INVALID_VIDEO_ID';
  }
}

function extractVideoId(input) {
  if (typeof input !== 'string') {
    throw new VideoIdError('Link hoặc ID video phải là chuỗi ký tự.');
  }
  const s = input.trim();
  if (!s) throw new VideoIdError('Chưa nhập link hoặc ID video.');

  // Plain 11-char ID.
  if (VIDEO_ID_RE.test(s)) return s;

  // Try as URL.
  let url;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    throw new VideoIdError('Link video không đúng định dạng YouTube.');
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (id && VIDEO_ID_RE.test(id)) return id;
  } else if (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  ) {
    // /watch?v=ID
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID_RE.test(v)) return v;
    // /shorts/ID, /embed/ID, /live/ID, /v/ID
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[\/?#]|$)/);
    if (m) return m[2];
  }

  throw new VideoIdError('Không tìm thấy ID video trong link này. Hãy dán link YouTube dạng youtube.com/watch?v=... hoặc youtu.be/...');
}

module.exports = { extractVideoId, VideoIdError, VIDEO_ID_RE };
