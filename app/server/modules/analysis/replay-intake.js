"use strict";
// Share-link intake ports the public-replay gate from RuokeZhang/pocket48-summarizer
// (MIT, commit d5f45afeef1766e16525393e1beb13d24b2452ba): the link must be the
// canonical h5.48.cn share, the returned liveId must match exactly, and Pocket48
// must report review=true with a non-empty stream path before any work starts.
const crypto = require('crypto');
const fs = require('fs');
const manager = require('../recorder/manager');
const replayImport = require('../recorder/replay-import');
const replay = require('../pocket48/replay');
const { parseShareUrl } = require('./replay-share');
const TTL_MS = 10 * 60000;
const previews = new Map();
function problem(message, code, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function prune(now = Date.now()) { for (const [id, row] of previews) if (row.expiresAt <= now) previews.delete(id); if (previews.size > 500) previews.delete(previews.keys().next().value); }
function existingArchive(liveId) {
  // Same "valid archive" definition as recorder/replay-import: the file must
  // still exist on disk, otherwise a recording row whose video was lost would
  // block re-import behind a phantom "existing archive" preview.
  const row = manager.getRecordings().find(rec => String(rec.liveId) === String(liveId) && rec.status === 'done' && rec.filePath && fs.existsSync(rec.filePath)) || null;
  return row ? { recordingId: row.id, title: row.title || '' } : null;
}
function importSummary(job) {
  if (!job) return null;
  const { id, status, progress, recordingId, error } = job;
  return { id, status, progress, recordingId: recordingId || null, error: error || null };
}
const activeImport = liveId => replayImport.activeFor(liveId) || null;
function nameOf(detail) {
  const member = detail?.member || {};
  return { member: { id: String(member.id || ''), name: String(member.name || '') } };
}
async function preview(source) {
  prune();
  const { liveId, canonicalUrl } = parseShareUrl(source);
  const archive = existingArchive(liveId);
  const importJob = activeImport(liveId);
  // Repeated clicks must not trigger another upstream lookup or download.
  if (archive) return { previewId: null, expiresAt: null, liveId, canonicalUrl, replay: null, archive, importJob };
  let detail = await replay.getReplay(liveId).catch(error => { throw problem('无法获取该场官方回放，请稍后重试', 'replay_lookup_failed', 502); });
  detail = detail?.replay || {};
  if (String(detail.liveId || '') !== liveId) throw problem('口袋48返回的直播 ID 与链接不一致', 'replay_id_mismatch', 422);
  if (detail.review !== true || !detail.streamPath) throw problem('该链接不是可处理的已结束公开回放', 'replay_not_ready', 409);
  const member = nameOf(detail).member;
  if (!member.name && member.id) member.name = await replay.memberLabel(member.id).catch(() => '');
  const previewId = crypto.randomBytes(18).toString('hex');
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  previews.set(previewId, { liveId, canonicalUrl, archive: null, expiresAt: Date.now() + TTL_MS });
  return {
    previewId, expiresAt, liveId, canonicalUrl, archive: null, importJob,
    replay: { title: String(detail.title || ''), member, startedAt: detail.startedAt || null, durationSeconds: Number.isFinite(detail.durationSeconds) ? detail.durationSeconds : null }
  };
}
function confirm(previewId) {
  prune();
  const row = previews.get(String(previewId || ''));
  if (!row) throw problem('回放预览已过期，请重新粘贴链接', 'preview_expired', 409);
  if (row.archive) return { kind: 'existing', recordingId: row.archive.recordingId };
  const archive = existingArchive(row.liveId);
  if (archive) return { kind: 'existing', recordingId: archive.recordingId };
  const active = activeImport(row.liveId);
  if (active) return { kind: 'import', job: active };
  // The existing importer re-checks duplicates and active recordings and performs
  // the full verified download. No paid analysis is queued by this step.
  // Idempotent: two confirmations of the same preview (double click, or the replay
  // watch racing a manual paste) must yield one job, matching upstream
  // `create_or_get_job`. The returned job is the live one either way.
  const job = replayImport.enqueue({ liveId: row.liveId });
  return { kind: 'import', job };
}
// Read-only views the replay watch needs so it never queues a duplicate import.
function archivedLiveIds() {
  return manager.getRecordings()
    .filter(rec => rec.status === "done" && rec.filePath)
    .map(rec => String(rec.liveId || ""))
    .filter(Boolean);
}
function activeLiveIds() { return replayImport.activeLiveIds(); }

module.exports = {
  preview,
  confirm,
  _internals: { previews, prune, existingArchive, archivedLiveIds, activeLiveIds, TTL_MS },
};
