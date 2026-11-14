"use strict";

const fs = require("fs");
const path = require("path");
const media = require("./replay-download");
const manager = require("./manager");
const backupLeases = require("../backup115/leases");
const ACTIVE = new Set(["pending", "downloading", "verifying", "waiting_replay", "awaiting_archive"]);
const RETRIES = [60000, 120000, 300000, 600000, 600000];
const captures = new Map();
const applying = new Map();
let serial = Promise.resolve();

function root() { return path.resolve(require("../pocket48/recorder")._internals.recordingsDir()); }
function directory(liveId) {
  if (!/^\d{1,30}$/.test(String(liveId))) throw new Error("无效直播 ID");
  const cache = path.join(root(), ".official-replays");
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const dir = path.join(cache, String(liveId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(cache) !== cache || fs.realpathSync(dir) !== dir) throw new Error("回放缓存目录不能使用符号链接");
  return dir;
}
function target(id) {
  const rec = manager.getRecording(id);
  return rec?.status === "merged" && rec.mergedInto ? manager.getRecording(rec.mergedInto) : rec;
}
function mark(id, values) {
  const rec = target(id);
  if (!rec || rec.status === "deleted") return;
  return manager.updateRecording(rec.id, { replayRecovery: { ...rec.replayRecovery, ...values, updatedAt: new Date().toISOString() } });
}
function busy(id) { return ACTIVE.has(target(id)?.replayRecovery?.status) || applying.has(String(id)); }
function isActive(rec) { return require("../pocket48/recorder").listActive().some(item => String(item.liveId) === String(rec.liveId)); }
function eligible(rec) { return rec?.source === "pocket48" && /^\d{1,30}$/.test(String(rec.liveId)) && rec.mediaType !== "audio" && !rec.manualStop; }
function needsQualityGate(rec) {
  return Boolean(rec?.source === "pocket48" && !rec.manualStop && rec.mediaType !== "audio");
}
function assertReplaceable(rec) {
  if (!eligible(rec) || rec.status !== "done") throw new Error("仅支持已归档、非手动停止的口袋视频录像");
  if (isActive(rec)) throw new Error("同场直播仍在录制，暂不替换");
  if (backupLeases.lockedRecording(rec)) throw new Error("录像文件正由115备份使用，请先取消115备份后再替换");
  if (rec.draftId || rec.uploadStatus === "done" || manager.getQueue().some(q => String(q.recordingId) === String(rec.id) && ["uploading", "paused_recording", "done"].includes(q.status))) throw new Error("录像已进入上传队列或草稿箱，已保留原录像");
  // 历史剪辑产物（parentRecordingId）仍然保护原录像不被替换，避免时间轴错位。
  if (manager.getRecordings().some(item => item.parentRecordingId === rec.id)) throw new Error("该录像存在历史剪辑产物，已保留原录像和下载的回放，避免时间轴错位");
  // Cancel only replaceable queued work, after every other replacement guard has passed.
  for (const item of manager.getQueue().filter(q => String(q.recordingId) === String(rec.id) && ["queued", "waiting_credentials"].includes(q.status))) {
    manager.updateQueueItem(item.id, { status: "failed", error: "录像需要官方回放核对，旧投稿任务已取消", failedAt: new Date().toISOString() });
  }
}
function compare(local, official, rec) {
  const localDuration = Number(local.format.duration), officialDuration = official.durationSeconds;
  const video = local.streams.find(s => s.codec_type === "video");
  const replayVideo = official.streams.find(s => s.codec_type === "video");
  const comparison = { localDuration, officialDuration, gainedSeconds: officialDuration - localDuration, localWidth: video.width, localHeight: video.height, officialWidth: replayVideo?.width, officialHeight: replayVideo?.height };
  if (officialDuration + 1 < localDuration) return { ...comparison, replace: false, reason: "官方回放比现有录像短，保留原录像" };
  if (!replayVideo || replayVideo.width * replayVideo.height < video.width * video.height * 0.95) return { ...comparison, replace: false, reason: "官方回放画面尺寸低于现有录像，保留原录像" };
  if (local.streams.some(s => s.codec_type === "audio") && !official.streams.some(s => s.codec_type === "audio")) return { ...comparison, replace: false, reason: "官方回放缺少原录像音轨，保留原录像" };
  if (officialDuration - localDuration <= Math.max(3, localDuration * 0.001) && !(rec.segmentCount > 1 || rec.exitCode && rec.exitCode !== 0)) return { ...comparison, replace: false, reason: "回放与现有录像时长接近，保留原录像" };
  return { ...comparison, replace: true, reason: "完整回放校验通过，可补全现有录像" };
}
function capture(rec, { automatic = true, force = false } = {}) {
  if (!eligible(rec) || isActive(rec)) return Promise.resolve(null);
  if (captures.has(String(rec.liveId))) return captures.get(String(rec.liveId));
  const state = rec.replayRecovery || {};
  if (!force && (state.status === "replaced" || state.status === "kept_local" || state.status === "failed")) return Promise.resolve(null);
  if (!force && state.status !== "awaiting_archive" && state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) return Promise.resolve(null);
  mark(rec.id, { status: "pending", automatic, message: "等待下载完整官方回放", nextAttemptAt: null, attempts: (state.attempts || 0) + 1, startedAt: state.startedAt || new Date().toISOString() });
  const job = serial.then(async () => {
    const latest = target(rec.id);
    if (!latest || latest.status === "deleted" || isActive(latest)) {
      mark(rec.id, { status: "waiting_replay", message: "等待同场直播结束", nextAttemptAt: new Date(Date.now() + 60000).toISOString() }); return null;
    }
    let lastUpdate = 0;
    mark(rec.id, { status: "downloading", message: "先完整下载回放，原录像仍保留" });
    try {
      const official = await media.downloadShared({ liveId: rec.liveId, directory: directory(rec.liveId), onProgress(progress) {
        if (Date.now() - lastUpdate < 1000 && !progress.verifying) return;
        lastUpdate = Date.now();
        mark(rec.id, { status: progress.verifying ? "verifying" : "downloading", downloadedSegments: progress.completed, totalSegments: progress.total, downloadedBytes: progress.bytes, progress: Math.floor(progress.completed / progress.total * 100), message: progress.verifying ? "下载已完成，正在离线校验整段回放" : `正在下载回放分片 ${progress.completed}/${progress.total}` });
      } });
      mark(rec.id, { status: "awaiting_archive", progress: 100, message: "回放已完整下载并通过校验，等待对比归档", replayFilePath: official.filePath, downloadedAt: official.downloadedAt });
      return official;
    } catch (error) {
      const attempts = target(rec.id)?.replayRecovery?.attempts || 1;
      const safeMessage = /^[\u4e00-\u9fff]/.test(error.message || "") ? error.message : "官方回放暂不可下载，原录像已保留";
      const delay = automatic ? RETRIES[attempts - 1] : undefined;
      mark(rec.id, { status: delay ? "waiting_replay" : "failed", qualityGate: delay ? undefined : { status: "manual_confirmation_required", reason: safeMessage }, message: safeMessage, nextAttemptAt: delay ? new Date(Date.now() + delay).toISOString() : null });
      return null;
    }
  });
  captures.set(String(rec.liveId), job);
  serial = job.catch(() => {});
  void job.finally(() => captures.delete(String(rec.liveId))).catch(() => {});
  return job;
}
function prefetch(rec) {
  // Review the finished archive first. Eager downloading duplicated complete recordings.
  void rec;
}
async function recover(rec, { automatic = true, force = false } = {}) {
  if (!eligible(rec)) return rec;
  if (applying.has(rec.id)) return applying.get(rec.id);
  const task = apply(rec, { automatic, force }); applying.set(rec.id, task);
  try { return await task; } finally { applying.delete(rec.id); }
}
async function apply(rec, options) {
  if (["replaced", "kept_local", "failed"].includes(rec.replayRecovery?.status) && !options.force) return rec;
  if (rec.replayRecovery?.status === "checked_local" && !options.force) return rec;
  if (options.automatic && !isActive(rec) && rec.status === "done" && !rec.exitCode && !(rec.segmentCount > 1)) {
    try {
      const metadata = await require("../pocket48/replay").findReplayMetadata(String(rec.liveId), String(rec.memberId || ""));
      const officialDuration = Number(metadata?.durationSeconds);
      const local = await media.probe(require("./archive-processor")._internals.resolveSource(rec.filePath));
      const localDuration = Number(local.format.duration);
      if (officialDuration > 0 && Math.abs(officialDuration - localDuration) <= Math.max(3, officialDuration * 0.001)) {
        await media.verifyFull(rec.filePath);
        if (isActive(rec) || manager.getRecording(rec.id)?.filePath !== rec.filePath) return manager.getRecording(rec.id);
        mark(rec.id, { status: "checked_local", qualityGate: { status: "passed", source: "local_verified" }, comparison: { localDuration, officialDuration, gainedSeconds: officialDuration - localDuration }, message: "本地录像完整校验通过，与官方时长一致，无需重复下载", nextAttemptAt: null });
        manager.updateRecording(rec.id, { retentionVerifiedAt: new Date().toISOString() });
        return manager.getRecording(rec.id);
      }
    } catch { /* Missing metadata or decode failure uses the full recovery path. */ }
  }
  const official = await capture(rec, options);
  if (!official) return manager.getRecording(rec.id);
  const latest = manager.getRecording(rec.id);
  try {
    assertReplaceable(latest);
    const localFile = require("./archive-processor")._internals.resolveSource(latest.filePath);
    const comparison = compare(await media.probe(localFile), official, latest);
    mark(latest.id, { comparison });
    if (!comparison.replace) { mark(latest.id, { status: "kept_local", qualityGate: { status: "manual_confirmation_required", reason: comparison.reason }, message: comparison.reason, nextAttemptAt: null }); return manager.getRecording(rec.id); }
    assertReplaceable(manager.getRecording(rec.id));
    // Keep the entire original archive and original segments. Switch the pointer
    // only after a durable audit record and complete replay are on disk.
    media.atomicJson(path.join(directory(latest.liveId), `before-${latest.id}.json`), { original: latest, official, comparison, savedAt: new Date().toISOString() });
    assertReplaceable(manager.getRecording(rec.id));
    if (backupLeases.lockedPath(localFile) || backupLeases.lockedPath(official.filePath)) throw new Error("录像文件正由115备份使用，请先取消115备份后再替换");
    manager.updateRecording(latest.id, {
      filePath: official.filePath, fileName: path.basename(localFile), container: "mp4", size: official.size, fileSize: official.size,
      duration: official.durationSeconds, durationSeconds: official.durationSeconds, archiveOrigin: "official_replay",
      archiveVersion: Math.max(1, Number(latest.archiveVersion) || 0) + 1,
      fileSha256: official.sha256 || null,
      sourceFiles: [...new Set([...(latest.sourceFiles || []), localFile])],
      coverPlanVersion: null, coverPlanKey: null, coverCandidates: null,
      replayRecovery: { ...latest.replayRecovery, status: "replaced", qualityGate: { status: "passed", source: "official_replay" }, nextAttemptAt: null, replacedAt: new Date().toISOString(), message: "已使用完整官方回放，原录像备份已保留" },
    });
  } catch (error) {
    mark(rec.id, { status: "kept_local", qualityGate: { status: "manual_confirmation_required", reason: error.message }, message: /^[\u4e00-\u9fff]/.test(error.message || "") ? error.message : "替换未完成，原录像已保留", nextAttemptAt: null });
  }
  return manager.getRecording(rec.id);
}
function enqueue(id) {
  const rec = manager.getRecording(id);
  if (!eligible(rec) || rec.status !== "done") { const error = new Error("请选择已归档、非手动停止的口袋视频录像"); error.statusCode = 400; throw error; }
  assertReplaceable(rec);
  if (busy(id)) return rec;
  if (rec.replayRecovery?.status === "replaced") return rec;
  mark(id, { status: "pending", automatic: false, attempts: 0, nextAttemptAt: null, message: "已加入官方回放下载与对比队列" });
  setImmediate(() => { void recover(manager.getRecording(id), { automatic: false, force: true }).catch(() => {}); });
  return manager.getRecording(id);
}
function holdsUpload(rec) { return ACTIVE.has(rec?.replayRecovery?.status); }
function uploadReadiness(rec, { autoUpload = false, confirmLocal = false } = {}) {
  if (!rec) return { ready: false, code: "RECORDING_NOT_FOUND", message: "Recording not found" };
  if (!needsQualityGate(rec)) return { ready: true, code: null, message: null };
  const state = rec.replayRecovery || null;
  const status = state?.status || "missing";
  if (status === "replaced" || status === "checked_local") {
    if (!rec.filePath || !fs.existsSync(rec.filePath)) return { ready: false, code: "REPLAY_FILE_MISSING", message: "官方回放文件不存在，请重新补全后再投稿" };
    return { ready: true, code: null, message: null };
  }
  if (!autoUpload && confirmLocal && (status === "kept_local" || status === "failed")) {
    return { ready: true, code: "LOCAL_CONFIRMED", message: null };
  }
  if (status === "kept_local") return { ready: false, code: "LOCAL_CONFIRMATION_REQUIRED", message: "官方回放未替换本地录像，请确认保留本地录像后再投稿" };
  if (status === "failed") return { ready: false, code: "REPLAY_RECOVERY_FAILED", message: "官方回放补全失败，请重试或确认保留本地录像后再投稿" };
  if (status === "missing" && confirmLocal) return { ready: true, code: "LOCAL_CONFIRMED", message: null };
  if (status === "missing") return { ready: false, code: "REPLAY_RECOVERY_REQUIRED", message: "请先完成官方回放核对，不能直接投稿" };
  return { ready: false, code: "REPLAY_RECOVERY_BUSY", message: "请等待官方回放下载、校验和对比完成" };
}
function assertUploadReady(rec, options = {}) {
  const result = uploadReadiness(rec, options);
  if (!result.ready) throw Object.assign(new Error(result.message), { statusCode: 409, code: result.code });
  return rec;
}
module.exports = { prefetch, recover, enqueue, busy, holdsUpload, uploadReadiness, assertUploadReady, _internals: { compare, assertReplaceable, captures, directory, ACTIVE, needsQualityGate } };
