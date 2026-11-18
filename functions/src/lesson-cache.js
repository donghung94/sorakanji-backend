'use strict';
/**
 * lesson-cache.js — shared Firestore cache for user-created lessons.
 *
 * Why: every paste of a YouTube link re-ran the whole pipeline (Gemini
 * transcription + translation, ~15-40s and ~$0.01-0.02). Popular videos
 * get pasted by many users — the 2nd user onwards should get the lesson
 * instantly, for free.
 *
 * Design:
 * - Collection `sv_lessons` (new; Tokutei collections are never touched).
 * - Doc ID = YouTube videoId. Doc = { version, lesson, cachedAt, ... }.
 * - Read-through: buildLesson/buildLessonFree check the cache first.
 * - Write-through: a freshly built lesson is stored (only when the
 *   translation completed — a vi-less lesson must not poison the cache).
 * - version (CACHE_VERSION): bump it when the pipeline changes materially
 *   and old entries must be rebuilt.
 * - Size guard: Firestore docs cap at 1 MiB; lessons serializing over
 *   MAX_CACHE_BYTES are not stored (very long videos just rebuild).
 * - All cache failures are NON-FATAL: a miss/error falls back to building.
 * - input.refresh === true skips the cache read (admin rebuild path).
 *
 * The Admin SDK is initialized in index.js; this module only uses it.
 * Local tests never touch the cache (they call buildLessonFromFetched).
 */

const admin = require('firebase-admin');

const COLLECTION = 'sv_lessons';
const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 800 * 1024;

function db() {
  return admin.firestore();
}

async function getCachedLesson(videoId) {
  try {
    const snap = await db().collection(COLLECTION).doc(videoId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (
      !data ||
      data.version !== CACHE_VERSION ||
      !data.lesson ||
      !Array.isArray(data.lesson.lines) ||
      data.lesson.lines.length === 0
    ) {
      return null;
    }
    return data.lesson;
  } catch (err) {
    console.warn('[lesson-cache] read failed for', videoId, '-', err.message);
    return null;
  }
}

async function putCachedLesson(videoId, lesson) {
  try {
    const json = JSON.stringify(lesson);
    if (Buffer.byteLength(json, 'utf8') > MAX_CACHE_BYTES) {
      console.warn('[lesson-cache] lesson too large to cache:', videoId);
      return false;
    }
    await db()
      .collection(COLLECTION)
      .doc(videoId)
      .set({
        version: CACHE_VERSION,
        videoId,
        title: lesson.title || '',
        source: lesson.source || '',
        lineCount: Array.isArray(lesson.lines) ? lesson.lines.length : 0,
        cachedAt: admin.firestore.FieldValue.serverTimestamp(),
        lesson: JSON.parse(json),
      });
    return true;
  } catch (err) {
    console.warn('[lesson-cache] write failed for', videoId, '-', err.message);
    return false;
  }
}

module.exports = { getCachedLesson, putCachedLesson, CACHE_VERSION, COLLECTION };
