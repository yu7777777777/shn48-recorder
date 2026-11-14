"use strict";

// Cross-archive subtitle full-text search ("这句话是哪场直播说的"). Read-only
// over the analysis_<id>.json files in the data directory; never touches the
// paid pipeline. An LRU cache keyed by file mtime keeps repeated queries from
// re-parsing multi-megabyte subtitle files.

const fs = require("fs");
const path = require("path");
const store = require("../../lib/store");
const manager = require("../recorder/manager");

const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const ANALYSIS_FILE = /^analysis_([\w-]{1,100})\.json$/;
// Backups, checkpoints and correction snapshots are versioned history, not the
// live subtitle set; only the exact analysis_<id>.json is searchable.
const EXCLUDED_SUFFIXES = ["_before_import", "_before_retranscribe", "_before_correction", "_before_manual_edit", "_before_restore", "_before_clear", "_summary_checkpoint"];
const MAX_QUERY = 100;
const MAX_FILES = 1000;
const MAX_MATCHES_PER_RECORDING = 20;
const MAX_TOTAL_MATCHES = 300;
const CACHE_LIMIT = 40;
const cache = new Map(); // recordingId -> {mtimeMs, size, segments}

function recordingDate(row) {
  for (const key of ["startedAt", "recordedAt", "endedAt", "archivedAt", "createdAt"]) {
    const parsed = Date.parse(row?.[key] || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function segmentsFor(recordingId) {
  const filePath = store.filePath(`analysis_${recordingId}`);
  let stat;
  try { stat = fs.statSync(filePath); } catch { cache.delete(recordingId); return null; }
  const hit = cache.get(recordingId);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    cache.delete(recordingId);
    cache.set(recordingId, hit);
    return hit.segments;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { cache.delete(recordingId); return null; }
  const segments = Array.isArray(data?.segments) ? data.segments : null;
  if (!segments) { cache.delete(recordingId); return null; }
  cache.set(recordingId, { mtimeMs: stat.mtimeMs, size: stat.size, segments });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return segments;
}

function listingIds() {
  let entries;
  try { entries = fs.readdirSync(store.dataDir); } catch { return []; }
  const ids = [];
  for (const entry of entries) {
    const match = ANALYSIS_FILE.exec(entry);
    if (!match) continue;
    if (EXCLUDED_SUFFIXES.some(suffix => entry.startsWith(`analysis_${match[1]}${suffix}`))) continue;
    ids.push(match[1]);
  }
  // Newest recordings first so early termination at the match cap favours the
  // archives an operator is most likely looking for.
  const order = new Map(manager.getRecordings({ includeMerged: true, includeDeleted: true }).map(row => [row.id, recordingDate(row)]));
  return ids.sort((a, b) => (order.get(b) || 0) - (order.get(a) || 0)).slice(0, MAX_FILES);
}

function search(query, options = {}) {
  const text = String(query ?? "").trim().slice(0, MAX_QUERY);
  if (!text) throw fail("请输入搜索关键词");
  const lower = text.toLowerCase();
  const member = String(options.member || "").trim().slice(0, 60);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const recordings = new Map(manager.getRecordings({ includeMerged: true, includeDeleted: true }).map(row => [row.id, row]));
  const results = [];
  let recordingsHit = 0;
  for (const recordingId of listingIds()) {
    if (results.length >= Math.min(limit, MAX_TOTAL_MATCHES)) break;
    const recording = recordings.get(recordingId);
    // Deleted archives keep orphan analysis files for a while; they are not
    // playable destinations, so a hit would be a dead end.
    if (!recording || recording.status === "deleted" || recording.source === "clip") continue;
    if (member && !(recording.memberName || "").toLowerCase().includes(member.toLowerCase())) continue;
    const segments = segmentsFor(recordingId);
    if (!segments) continue;
    const matches = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const value = typeof segment?.text === "string" ? segment.text : "";
      if (!value || !value.toLowerCase().includes(lower)) continue;
      matches.push({ index, start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: value });
      if (matches.length >= MAX_MATCHES_PER_RECORDING) break;
    }
    if (!matches.length) continue;
    recordingsHit += 1;
    results.push({
      recordingId,
      title: recording.title || "",
      memberName: recording.memberName || "",
      liveId: recording.liveId || null,
      mediaType: recording.mediaType === "audio" ? "audio" : "video",
      date: new Date(recordingDate(recording) || Date.parse(recording.createdAt) || 0).toISOString(),
      startedAt: recording.startedAt || recording.recordedAt || recording.createdAt || null,
      duration: Number(recording.duration) || 0,
      matches: matches.slice(0, Math.max(1, Math.min(limit - results.length, MAX_MATCHES_PER_RECORDING))),
    });
  }
  return { query: text, recordingsHit, totalMatches: results.reduce((sum, row) => sum + row.matches.length, 0), truncated: results.length >= Math.min(limit, MAX_TOTAL_MATCHES), results };
}

function _resetCache() { cache.clear(); }

module.exports = { search, _internals: { _resetCache, listingIds, MAX_TOTAL_MATCHES } };
