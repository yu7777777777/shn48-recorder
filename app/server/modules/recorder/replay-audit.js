"use strict";

// Historical replay audit. Scanning is read-only; repairs are bounded to one job,
// preserve the original file; posted recordings never touch the Bilibili queue or draft state.
const fs = require("fs");
const path = require("path");
const store = require("../../lib/store");
const manager = require("./manager");
const replay = require("../pocket48/replay");
const media = require("./replay-download");
const replayRecovery = require("./replay-recovery");

const KEY = "replay_audit";
const DEFAULT_DAYS = Math.max(1, Number(process.env.REPLAY_AUDIT_DAYS) || 45);
const SCAN_INTERVAL_MS = Math.max(15 * 60 * 1000, Number(process.env.REPLAY_AUDIT_INTERVAL_MS) || 6 * 60 * 60 * 1000);
const RETRIES = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const REPAIR_FAILURE_REASON = "修复失败，原录像已保留，稍后自动重试";
const records = new Map(Object.entries(store.load(KEY, {}) || {}).map(([id, item]) => [id,
  item?.status === "repairing" ? { ...item, status: item.posted ? "published_needs_repair" : "repairable", reason: "服务重启后继续修复", nextAttemptAt: new Date(Date.now() + 60000).toISOString() } : item]));
let scanTask = null;
let repairTask = null;
let timer = null;
let repairTimer = null;
let started = false;
let state = { running: false, lastStartedAt: null, lastFinishedAt: null, scanned: 0, error: null };

function posted(rec) {
  if (!rec) return false;
  if (rec.draftId || rec.uploadStatus === "done") return true;
  return manager.getQueue().some(item => String(item.recordingId) === String(rec.id) && ["done", "uploading", "paused_recording", "queued", "waiting_credentials"].includes(item.status));
}
function eligible(rec) {
  return rec?.source === "pocket48" && rec.status === "done" && !rec.manualStop && /^\d{1,30}$/.test(String(rec.liveId || "")) && rec.mediaType !== "audio";
}
function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function tolerance(seconds) { return Math.max(30, seconds * 0.005); }
function persist() { media.atomicJson(store.filePath(KEY), Object.fromEntries(records)); }
function archivePresent(rec) {
  if (!rec || rec.status === "deleted" || rec.status === "merged" || !rec.filePath) return false;
  try { return fs.statSync(rec.filePath).isFile(); } catch { return false; }
}
function remove(id) {
  const removed = records.delete(String(id));
  if (removed) persist();
  return removed;
}
function prune() {
  let changed = false;
  for (const id of records.keys()) {
    if (!archivePresent(manager.getRecording(id))) { records.delete(id); changed = true; }
  }
  if (changed) persist();
  return changed;
}
function saveResult(id, result) {
  // An in-flight metadata lookup can finish after the archive was deleted.
  if (!archivePresent(manager.getRecording(String(id)))) { remove(id); return null; }
  records.set(String(id), { ...(records.get(String(id)) || {}), ...result, recordingId: String(id), updatedAt: new Date().toISOString() });
  persist();
  return records.get(String(id));
}
function queueCandidates() {
  return [...records.values()]
    .filter(item => ["repairable", "published_needs_repair"].includes(item.status) && item.nextAttemptAt && Date.parse(item.nextAttemptAt) <= Date.now())
    .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)));
}
function localDuration(rec) {
  return parseDuration(rec.durationSeconds ?? rec.duration);
}
function hasRepairBackoff(item) {
  if (item.retryType === "repair") return true;
  if (item.retryType === "lookup" || !["repairable", "published_needs_repair"].includes(item.status)) return false;
  // Older records have no retryType. Query errors may already have been rescanned
  // into a repairable status, so use the persisted repair reason to retain only its delay.
  return item.reason === REPAIR_FAILURE_REASON;
}
async function inspect(rec) {
  const id = String(rec.id);
  if (!archivePresent(manager.getRecording(id))) { remove(id); return null; }
  const old = records.get(id) || {};
  if (old.status === "repairing" || /^repaired_(?:local|source_limited)/.test(rec.replayAudit?.status || "")) return old;
  const fileExists = Boolean(rec.filePath && fs.existsSync(rec.filePath));
  let localSeconds = localDuration(rec);
  if (fileExists) {
    try { const safe = require("./archive-processor")._internals.resolveSource(rec.filePath); localSeconds = parseDuration((await media.probe(safe)).format.duration); }
    catch { return saveResult(id, { status: "manual", reason: "本地录像探测失败或文件路径不安全", localSeconds, officialSeconds: null, posted: posted(rec), title: rec.title, liveId: String(rec.liveId) }); }
  }
  if (!fileExists) return saveResult(id, { status: "manual", reason: "本地录像文件不存在，无法安全替换", localSeconds, officialSeconds: null, posted: posted(rec), title: rec.title, liveId: String(rec.liveId) });
  try {
    const detail = await replay.findReplayMetadata(String(rec.liveId), String(rec.memberId || ""));
    const officialSeconds = parseDuration(detail?.durationSeconds);
    if (!officialSeconds) {
      const repairBackoff = hasRepairBackoff(old);
      return saveResult(id, { status: "official_unavailable", reason: detail ? "官方列表有回放，但暂无有效时长，稍后自动重试" : "官方列表暂未找到同场回放，稍后自动重试", error: null, localSeconds, officialSeconds: null, posted: posted(rec), title: rec.title, liveId: String(rec.liveId), nextAttemptAt: repairBackoff ? old.nextAttemptAt : new Date(Date.now() + RETRIES[Math.min(Number(old.attempts || 0), RETRIES.length - 1)]).toISOString(), attempts: repairBackoff ? Number(old.attempts || 0) : Number(old.attempts || 0) + 1, retryType: repairBackoff ? "repair" : "lookup" });
    }
    const isShort = localSeconds > 0 && officialSeconds - localSeconds > tolerance(officialSeconds);
    const isPosted = posted(rec);
    if (isShort && old.comparisonBlocked && old.status === "manual" && old.officialSeconds === officialSeconds && Math.abs(Number(old.localSeconds) - localSeconds) < 0.5) {
      return saveResult(id, { lastCheckedAt: new Date().toISOString(), nextAttemptAt: null, posted: isPosted });
    }
    const status = isShort ? (isPosted ? "published_needs_repair" : "repairable") : (officialSeconds + tolerance(officialSeconds) < localSeconds ? "manual" : "healthy");
    const reason = isShort ? (isPosted ? "B站已有投稿，仅修复本地归档，不改投稿" : "官方回放明显更完整，可自动修复") : status === "healthy" ? "本地录像与官方回放时长接近" : "本地录像比官方回放更长，需人工确认";
    const repairBackoff = isShort && hasRepairBackoff(old);
    return saveResult(id, { status, reason: repairBackoff ? REPAIR_FAILURE_REASON : reason, error: repairBackoff ? old.lastRepairError || old.error || null : null, lastRepairError: repairBackoff ? old.lastRepairError || old.error || null : null, comparisonBlocked: false, localSeconds, officialSeconds, differenceSeconds: officialSeconds - localSeconds, posted: isPosted, title: rec.title, liveId: String(rec.liveId), lastCheckedAt: new Date().toISOString(), nextAttemptAt: isShort ? (repairBackoff ? old.nextAttemptAt : new Date().toISOString()) : null, attempts: repairBackoff ? Number(old.attempts || 0) : 0, retryType: repairBackoff ? "repair" : null });
  } catch (error) {
    const attempts = Number(old.attempts || 0);
    const delay = RETRIES[Math.min(attempts, RETRIES.length - 1)];
    const message = String(error?.message || "回放查询失败");
    const unavailable = /暂不可用|尚未生成|暂无有效|不存在|未生成/.test(message);
    const repairBackoff = hasRepairBackoff(old);
    return saveResult(id, { status: unavailable ? "official_unavailable" : "temporary_error", reason: unavailable ? "官方回放尚未生成，稍后自动重试" : "官方回放查询临时失败，稍后自动重试", error: unavailable ? "官方回放尚未生成" : "上游查询暂时失败", localSeconds, officialSeconds: null, posted: posted(rec), title: rec.title, liveId: String(rec.liveId), nextAttemptAt: repairBackoff ? old.nextAttemptAt : new Date(Date.now() + delay).toISOString(), attempts, retryType: repairBackoff ? "repair" : "lookup" });
  }
}
async function scan({ days = DEFAULT_DAYS, limit = 100, autoRepair = true } = {}) {
  prune();
  if (scanTask) return scanTask;
  scanTask = (async () => {
    state = { ...state, running: true, lastStartedAt: new Date().toISOString(), error: null };
    try {
      const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_DAYS) * 86400000;
      const candidates = manager.getRecordings({ includeMerged: false }).filter(rec => eligible(rec) && Date.parse(rec.createdAt || rec.startedAt || 0) >= cutoff).slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
      for (const rec of candidates) await inspect(rec);
      state = { ...state, running: false, scanned: candidates.length, lastFinishedAt: new Date().toISOString() };
      if (autoRepair) setTimeout(() => { void pump().catch(() => {}); }, 0);
      return summary();
    } catch (error) {
      state = { ...state, running: false, error: error?.message || "审计失败", lastFinishedAt: new Date().toISOString() };
      throw error;
    } finally { scanTask = null; }
  })();
  return scanTask;
}
async function performRepair(id, { force = false } = {}) {
  const rec = manager.getRecording(id);
  if (!archivePresent(rec)) { remove(id); throw Object.assign(new Error("录像归档已删除或文件不存在，请刷新历史审计"), { statusCode: 404 }); }
  if (!eligible(rec)) throw Object.assign(new Error("仅支持已归档、非手动停止的 Pocket48 视频录像"), { statusCode: 400 });
  const previous = records.get(String(id));
  if (!force && !["repairable", "published_needs_repair"].includes(previous?.status)) throw Object.assign(new Error("该录像没有确认的官方回放缺口"), { statusCode: 409 });
  const activeUpload = manager.getQueue().some(item => String(item.recordingId) === String(id) && ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(item.status));
  if (activeUpload || replayRecovery.busy(id)) return saveResult(id, { status: "manual", reason: "上传或回放修复任务正在使用录像，请等待后重试", nextAttemptAt: null });
  const isPosted = posted(rec);
  saveResult(id, { status: "repairing", reason: isPosted ? "已投稿，仅修复本地归档" : "正在下载官方回放修复本地归档", error: null, attempts: Number(previous?.attempts || 0) + 1, nextAttemptAt: null, posted: isPosted });
  try {
    const original = require("./archive-processor")._internals.resolveSource(rec.filePath);
    const info = await media.probe(original);
    const actualLocalSeconds = parseDuration(info.format.duration);
    const dir = replayRecovery._internals.directory(rec.liveId);
    const stat = fs.statfsSync(dir, { bigint: true });
    const free = Number(stat.bavail * stat.bsize);
    const estimated = Math.max(1024 ** 3, fs.statSync(original).size / Math.max(1, actualLocalSeconds) * (previous.officialSeconds || actualLocalSeconds) * 2 + 1024 ** 3);
    if (free < estimated) throw new Error("磁盘空间不足，已保留原录像");
    let official = await media.downloadShared({ liveId: rec.liveId, directory: dir, verify: true });
    // Old verified caches may have passed using the longest stream while video
    // timestamps collapsed at reconnects. Recheck the source once with the new
    // timeline handling before deciding it cannot improve the local archive.
    if (official.timelineVersion !== 1 && parseDuration(official.durationSeconds) <= actualLocalSeconds + tolerance(parseDuration(official.durationSeconds))) {
      // The old verified cache can itself be the current archive. Never replace
      // its bytes until the fresh candidate has passed the archive comparison.
      official = await media.downloadShared({ liveId: rec.liveId, directory: path.join(dir, "audit-timeline-v1"), verify: true, refresh: true });
    }
    const officialSeconds = parseDuration(official.durationSeconds);
    const localSeconds = actualLocalSeconds;
    const comparison = replayRecovery._internals.compare(info, official, rec);
    const localVideo = info.streams.find(s => s.codec_type === "video"), officialVideo = official.streams.find(s => s.codec_type === "video");
    const sourceLimited = force && official.verification === "full" && official.filePath !== original && officialSeconds >= localSeconds && officialVideo && officialVideo.width * officialVideo.height >= localVideo.width * localVideo.height * 0.95 && (!info.streams.some(s => s.codec_type === "audio") || official.streams.some(s => s.codec_type === "audio")) && Number(previous.officialSeconds || 0) - officialSeconds > tolerance(Number(previous.officialSeconds || 0));
    if ((!comparison.replace || !(officialSeconds > localSeconds + tolerance(officialSeconds))) && !sourceLimited) {
      const message = `官方列表 ${Number(previous.officialSeconds || 0).toFixed(2)} 秒，实际回放 ${officialSeconds.toFixed(2)} 秒，本地 ${localSeconds.toFixed(2)} 秒；${comparison.reason || "实际回放不足以补全"}`;
      return saveResult(id, { status: "manual", reason: "官方可下载回放未通过补全比较，需人工确认", error: message, downloadableSeconds: officialSeconds, comparisonBlocked: true, nextAttemptAt: null, retryType: null, lastRepairError: null });
    }
    const repairedStatus = sourceLimited ? (isPosted ? "repaired_source_limited_published" : "repaired_source_limited") : (isPosted ? "repaired_local_published" : "repaired_local");
    const listedOfficialSeconds = sourceLimited ? Number(previous.officialSeconds || 0) : null;
    const repairReason = sourceLimited ? `已修复时间轴并保留全部可下载内容；官方列表标注 ${listedOfficialSeconds.toFixed(2)} 秒，实际源只有 ${officialSeconds.toFixed(2)} 秒，缺少部分无法补回` : null;
    const latest = manager.getRecording(id);
    if (!latest || latest.filePath !== rec.filePath || posted(latest) !== isPosted || replayRecovery.busy(id) || manager.getQueue().some(item => String(item.recordingId) === String(id) && ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(item.status))) throw new Error("录像或上传状态已变化，已保留原录像");
    const backup = { recordingId: rec.id, comparison, original: { filePath: rec.filePath, fileName: rec.fileName, durationSeconds: localSeconds, sourceFiles: rec.sourceFiles || [] }, official: { filePath: official.filePath, durationSeconds: officialSeconds, size: official.size }, posted: isPosted, savedAt: new Date().toISOString() };
    media.atomicJson(path.join(dir, `audit-before-${rec.id}.json`), backup);
    manager.updateRecording(rec.id, {
      filePath: official.filePath, fileName: path.basename(rec.fileName || official.filePath), container: "mp4", size: official.size, fileSize: official.size,
      duration: officialSeconds, durationSeconds: officialSeconds, archiveOrigin: "official_replay",
      archiveVersion: Math.max(1, Number(rec.archiveVersion) || 0) + 1,
      fileSha256: official.sha256 || null,
      sourceFiles: [...new Set([...(rec.sourceFiles || []), rec.filePath])],
      replayRecovery: { ...(rec.replayRecovery || {}), status: "replaced", replacedAt: new Date().toISOString(), nextAttemptAt: null, message: isPosted ? "历史审计已替换本地归档，B站投稿保持不变" : "历史审计已使用完整官方回放，等待质量闸门确认" },
      replayAudit: { status: repairedStatus, localSeconds, officialSeconds, listedOfficialSeconds, comparison, repairedAt: new Date().toISOString(), originalFile: rec.filePath, backupFile: path.join(dir, `audit-before-${rec.id}.json`) },
    });
    let uploadQueued = false;
    let uploadError = null;
    if (!isPosted && rec.autoUpload === true && !rec.draftId && rec.uploadStatus !== "done" && !manager.getQueue().some(item => String(item.recordingId) === String(id))) {
      try {
        require("../bilibili/queue").enqueueRecording(id, { mode: "draft", autoUpload: true, title: rec.title });
        uploadQueued = true;
      } catch (error) { uploadError = /^[\u4e00-\u9fff]/.test(error?.message || "") ? error.message : "自动投稿入队失败"; }
    }
    return saveResult(id, { status: repairedStatus, reason: repairReason || (isPosted ? "本地已替换为完整官方回放，B站投稿保持不变" : uploadQueued ? "本地已修复，已进入 B站草稿队列" : uploadError ? "本地已修复，自动投稿入队失败，需人工处理" : "本地已修复，未配置自动投稿"), uploadError, uploadQueued, repairedAt: new Date().toISOString(), localSeconds, officialSeconds, listedOfficialSeconds, differenceSeconds: officialSeconds - localSeconds, manualRepair: false, comparisonBlocked: false, nextAttemptAt: null, attempts: Number(previous?.attempts || 0) + 1, retryType: null, error: null, lastRepairError: null });
  } catch (error) {
    // A failed historical repair must not leave thousands of HLS segments or a
    // half-written MP4 visible in storage. The original recording remains the
    // source of truth and a future retry starts from a clean cache.
    media.cleanupTransient(replayRecovery._internals.directory(rec.liveId));
    media.cleanupTransient(path.join(replayRecovery._internals.directory(rec.liveId), "audit-timeline-v1"));
    const attempts = Number(previous?.attempts || 0) + 1;
    const delay = RETRIES[Math.min(attempts - 1, RETRIES.length - 1)];
    const message = /^[\u4e00-\u9fff]/.test(error?.message || "") ? error.message : "修复失败，原录像已保留";
    return saveResult(id, { status: isPosted ? "published_needs_repair" : "repairable", reason: REPAIR_FAILURE_REASON, error: message, lastRepairError: message, nextAttemptAt: new Date(Date.now() + delay).toISOString(), attempts, retryType: "repair" });
  }
}
async function pump() {
  if (repairTask || scanTask) return repairTask;
  const item = queueCandidates()[0];
  if (!item) return null;
  return repair(item.recordingId, { force: item.manualRepair === true });
}
function repair(id, options = {}) {
  const rec = manager.getRecording(String(id));
  if (!archivePresent(rec)) { remove(id); throw Object.assign(new Error("录像归档已删除或文件不存在，请刷新历史审计"), { statusCode: 404 }); }
  if (!eligible(rec)) throw Object.assign(new Error("仅支持已归档、非手动停止的 Pocket48 视频录像"), { statusCode: 409 });
  if (!options.force && !["repairable", "published_needs_repair"].includes(records.get(String(id))?.status)) throw Object.assign(new Error("该录像没有确认的官方回放缺口，请先扫描"), { statusCode: 409 });
  if (repairTask) throw Object.assign(new Error("已有一条历史录像正在修复，请稍后重试"), { statusCode: 409 });
  repairTask = performRepair(id, options).finally(() => { repairTask = null; setTimeout(() => { void pump().catch(() => {}); }, 1000); });
  return repairTask;
}
function summary() {
  prune();
  const items = [...records.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const counts = items.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  return { items, counts, state: { ...state }, nextRepairAt: queueCandidates()[0]?.nextAttemptAt || null };
}
function start() {
  prune();
  if (started) return;
  started = true;
  const delay = Math.max(10000, Number(process.env.REPLAY_AUDIT_START_DELAY_MS) || 30000);
  timer = setTimeout(() => { void scan({ autoRepair: true }).catch(() => {}); timer = setInterval(() => { void scan({ autoRepair: true }).catch(() => {}); }, SCAN_INTERVAL_MS); }, delay);
  repairTimer = setInterval(() => { void pump().catch(() => {}); }, 5 * 60 * 1000);
}
function stop() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } if (repairTimer) { clearInterval(repairTimer); repairTimer = null; } started = false; }
// Reconcile persisted audit state as soon as the module is loaded. This keeps
// a deleted archive from resurfacing before the scheduled scan starts.
prune();
module.exports = { start, stop, scan, repair, pump, summary, inspect, remove, busy: id => Boolean(repairTask && records.get(String(id))?.status === "repairing"), _internals: { records, posted, eligible, tolerance, RETRIES, KEY, prune, archivePresent } };

