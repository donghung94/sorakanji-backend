'use strict';
/**
 * whisper.js — PHASE 2 (NOT IMPLEMENTED, deliberately not wired up).
 *
 * Purpose: transcribe videos that have NO captions at all, using OpenAI
 * Whisper (or another speech-to-text model).
 *
 * Why this is phase 2 and not built now:
 *   1. YouTube Terms of Service: downloading a video's audio track
 *      (yt-dlp / stream rip) to feed a transcriber violates YouTube's ToS.
 *      The caption path in captions.js only READS the subtitles YouTube
 *      already publishes for the video — a much lighter touch.
 *      A Whisper path would need the audio file, i.e. a download.
 *   2. Cost + infra: audio download -> Cloud Storage -> Whisper API
 *      (~$0.006 / phút) -> timestamps are word-level, not sentence-level,
 *      so sentence segmentation + translation quality need their own pass.
 *   3. Quality: Whisper on casual Japanese conversation still makes
 *      errors; the result would need the same human review as auto-subs.
 *
 * What phase 2 would need (decision gate for the user):
 *   - Explicit user decision to accept the ToS risk, OR a scope limit to
 *     videos the user owns / has permission to process.
 *   - OPENAI_API_KEY stored in Secret Manager (never in code).
 *   - yt-dlp audio extraction (`-f bestaudio --extract-audio --audio-format mp3`),
 *     upload to a private Cloud Storage bucket, Whisper `transcriptions`
 *     call with `response_format: verbose_json` + `timestamp_granularities: ["segment"]`,
 *     then the same parse/translate/furigana pipeline.
 *   - A hard per-day quota + paid-tier gate (this path costs real money per video).
 *
 * This module exists only so the shape of phase 2 is visible in one place.
 * pipeline.js never calls it.
 */

class WhisperNotImplemented extends Error {
  constructor() {
    super(
      'Video này không có phụ đề nên chưa xử lý được. Tính năng chép lời bằng AI (Whisper) là phase 2 — chưa bật vì tải audio từ YouTube vi phạm điều khoản của YouTube. Xem README mục "Phase 2: Whisper".'
    );
    this.name = 'WhisperNotImplemented';
    this.code = 'WHISPER_PHASE2';
  }
}

async function transcribeWithWhisper(/* videoId */) {
  throw new WhisperNotImplemented();
}

module.exports = { transcribeWithWhisper, WhisperNotImplemented };
