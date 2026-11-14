"use strict";

const fs = require("fs");
const path = require("path");
const manager = require("../recorder/manager");
const biliDraft = require("./draft");

const HOME = process.env.HOME || process.env.USERPROFILE || "/root";
const COOKIES_PATH = process.env.COOKIES_PATH || path.join(HOME, "biliup", "cookies.json");
const running = new Set();
const QUEUE_STATUSES = new Set(["queued", "waiting_credentials", "uploading", "paused_recording", "failed", "done"]);
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.BILI_UPLOAD_CONCURRENCY) || 1));
const REUSABLE_UPOS_MS = 24 * 60 * 60 * 1000;
const ACTIVE_UPLOAD_STATUSES = new Set(["queued", "waiting_credentials", "uploading", "paused_recording"]);
let recordingActive = false;
const pausedWaiters = new Set();

function safeBaseName(value) {
  return path.posix.basename(String(value || "").replace(/\\/g, "/")).slice(0, 255);
}

function queueError(item) {
  if (typeof item.error !== "string") return "";
  let value = item.error;
  if (item.file) value = value.split(String(item.file)).join("[recording]");
  return value.slice(0, 500);
}

function toQueueDto(item) {
  const status = QUEUE_STATUSES.has(item && item.status) ? item.status : "failed";
  const progress = Number(item && item.progress);
  return {
    id: String((item && item.id) || ""),
    recordingId: String((item && item.recordingId) || ""),
    title: typeof (item && item.title) === "string" ? item.title.slice(0, 200) : "",
    fileName: safeBaseName(item && (item.file || item.fileName)),
    status,
    pausedRecording: status === "paused_recording",
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0,
    mode: item && item.mode === "publish" ? "publish" : "draft",
    retries: Math.max(0, Number.isSafeInteger(Number(item && item.retries)) ? Number(item.retries) : 0),
    addedAt: (item && item.addedAt) || null,
    startedAt: (item && item.startedAt) || null,
    completedAt: (item && item.completedAt) || null,
    failedAt: (item && item.failedAt) || null,
    draftId: item && item.draftId !== undefined ? item.draftId : null,
    aid: item && item.aid !== undefined ? item.aid : null,
    bvid: typeof (item && item.bvid) === "string" ? item.bvid.slice(0, 30) : "",
    // A successful task must not keep displaying a stale failure from an
    // interrupted earlier attempt.
    error: status === "done" ? "" : queueError(item || {}),
  };
}

function uploadError(message, statusCode, code, existingItem = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.existingItem = existingItem;
  return error;
}

function alreadyUploadedError(existingItem = null) {
  return uploadError(
    "该录像已上传到 B站草稿箱，请勿重复上传",
    409,
    "ALREADY_UPLOADED",
    existingItem
  );
}

function findCompletedUpload(recordingId) {
  return manager.getQueue().find((item) =>
    String(item.recordingId) === String(recordingId) && item.status === "done"
  ) || null;
}

function summarizeQueue(items) {
  const summary = { total: 0, queued: 0, waiting_credentials: 0, uploading: 0, failed: 0, done: 0 };
  for (const item of items || []) {
    summary.total += 1;
    const status = QUEUE_STATUSES.has(item && item.status) ? item.status : "failed";
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

function schedule(id) {
  // `id` is deliberately ignored: one shared pump serializes uploads by default.
  void id;
  setImmediate(pump);
}

function pump() {
  // Never start a new upload while recording is active. Existing uploads pause
  // through beforeChunk(), preserving their UPOS session and queue item.
  if (recordingActive) return;
  while (running.size < UPLOAD_CONCURRENCY) {
    const item = manager.getQueue().find((candidate) => candidate.status === "queued" && !running.has(candidate.id));
    if (!item) return;
    processItem(item.id).catch((err) => {
      running.delete(item.id);
      manager.updateQueueItem(item.id, { status: "failed", error: err.message, failedAt: new Date().toISOString() });
    }).finally(() => setImmediate(pump));
  }
}

async function waitForRecordingToFinish(id) {
  if (!recordingActive) return;
  manager.updateQueueItem(id, { status: "paused_recording", pauseReason: "recording_active" });
  await new Promise((resolve) => pausedWaiters.add(resolve));
  manager.updateQueueItem(id, { status: "uploading", pauseReason: null });
}

function setRecordingActive(active) {
  const next = active === true;
  if (recordingActive === next) return;
  recordingActive = next;
  if (!recordingActive) {
    for (const resolve of pausedWaiters) resolve();
    pausedWaiters.clear();
    setImmediate(pump);
  }
}

function getCredentials() {
  if (!fs.existsSync(COOKIES_PATH)) return null;
  return biliDraft.loadCredentials(COOKIES_PATH);
}

function normalizeMode(mode) {
  if (mode === undefined || mode === null || mode === "") return "draft";
  if (!new Set(["draft", "publish"]).has(mode)) throw new Error("mode must be draft or publish");
  return mode;
}

function buildItem(recording, options = {}) {
  if (!recording || recording.status !== "done") throw new Error("Only completed recordings can be uploaded");
  if (!recording.filePath || !fs.existsSync(recording.filePath)) throw new Error("Recording file not found");
  const stat = fs.statSync(recording.filePath);
  return {
    recordingId: recording.id,
    file: recording.filePath,
    title: options.title || recording.title || path.basename(recording.filePath, path.extname(recording.filePath)),
    tid: Number(options.tid) || 171,
    tags: options.tags || "SNH48,直播",
    desc: options.desc || "",
    copyright: Number(options.copyright) || 1,
    mode: normalizeMode(options.mode),
    autoUpload: options.autoUpload === true,
    archiveVersion: Number(recording.archiveVersion) || 0,
    fileFingerprint: { size: stat.size, mtimeMs: stat.mtimeMs },
    fileSha256: recording.fileSha256 || null,
    confirmLocal: options.confirmLocal === true,
  };
}

function enqueueRecording(recordingId, options = {}) {
  const recording = manager.getRecording(recordingId);
  if (!recording) throw new Error("Recording not found");
  if (require("../recorder/replay-recovery").busy(recordingId)) throw uploadError("请等待官方回放下载、校验和对比完成", 409, "REPLAY_RECOVERY_BUSY");
  const completed = findCompletedUpload(recordingId);
  if (completed || recording.uploadStatus === "done" || recording.draftId) {
    throw alreadyUploadedError(completed);
  }
  require("../recorder/replay-recovery").assertUploadReady(recording, {
    autoUpload: options.autoUpload === true,
    confirmLocal: options.confirmLocal === true,
  });
  const existing = manager.getQueue().find((item) =>
    String(item.recordingId) === String(recordingId) && ACTIVE_UPLOAD_STATUSES.has(item.status)
  );
  if (existing) return existing;
  if (!options.autoUpload && !getCredentials()) throw new Error("Bilibili is not logged in");
  const item = manager.enqueueUpload(buildItem(recording, options));
  schedule(item.id);
  return item;
}

// Manual reupload is intentionally separate from the normal enqueue path. A
// repaired archive may still have a historical `draftId`/completed queue item
// even after that draft was deleted upstream. Callers must verify the remote
// draft list before invoking this function.
function enqueueReuploadRecording(recordingId, options = {}) {
  const recording = manager.getRecording(recordingId);
  if (!recording) throw uploadError("Recording not found", 404, "RECORDING_NOT_FOUND");
  if (recording.status !== "done") throw uploadError("Only completed recordings can be uploaded", 400, "RECORDING_NOT_READY");
  if (recording.replayAudit?.status !== "repaired_local_published") {
    throw uploadError("仅允许对已修复的历史投稿录像重新投稿", 409, "REUPLOAD_REPAIR_REQUIRED");
  }
  if (recording.bvid || recording.uploadMode === "publish" || manager.getQueue().some(item => String(item.recordingId) === String(recordingId) && item.mode === "publish" && item.status === "done")) {
    throw uploadError("该录像已有已发布的 B站稿件，不能按草稿重新投稿", 409, "REUPLOAD_PUBLISHED");
  }
  const active = manager.getQueue().find(item => String(item.recordingId) === String(recordingId) && ACTIVE_UPLOAD_STATUSES.has(item.status));
  if (active) throw uploadError("该录像已有投稿任务正在进行，请勿重复操作", 409, "REUPLOAD_ACTIVE", active);
  require("../recorder/replay-recovery").assertUploadReady(recording, { autoUpload: false, confirmLocal: true });
  if (!getCredentials()) throw uploadError("Bilibili is not logged in", 401, "BILIBILI_NOT_LOGGED_IN");
  const item = manager.enqueueUpload(buildItem(recording, { ...options, mode: "draft", autoUpload: false, confirmLocal: true, manualReupload: true }));
  manager.updateQueueItem(item.id, {
    manualReupload: true,
    reuploadOf: recording.uploadJobId || null,
    reuploadArchiveVersion: Number(recording.archiveVersion) || 0,
  });
  const history = Array.isArray(recording.uploadHistory) ? recording.uploadHistory : [];
  manager.updateRecording(recording.id, {
    // Clear only the current remote pointer. The prior upload remains in the
    // durable history so a deleted draft is never mistaken for a new upload.
    draftId: null,
    uploadStatus: "queued",
    uploadMode: "draft",
    uploadJobId: item.id,
    uploadHistory: [...history, {
      type: "manual_reupload",
      jobId: item.id,
      previousDraftId: recording.draftId || null,
      previousUploadJobId: recording.uploadJobId || null,
      archiveVersion: Number(recording.archiveVersion) || 0,
      queuedAt: new Date().toISOString(),
    }],
  });
  schedule(item.id);
  return item;
}

async function processItem(id) {
  if (running.has(id)) return manager.getQueueItem(id);
  const item = manager.getQueueItem(id);
  if (!item) throw new Error("Upload queue item not found");
  if (item.status !== "queued") return item;
  // Reserve the slot before conversion (the first await), including direct calls.
  running.add(id);
  try {
    return await processReservedItem(id, item);
  } finally {
    running.delete(id);
    setImmediate(pump);
  }
}

async function processReservedItem(id, item) {
  let creds;
  try { creds = getCredentials(); }
  catch (err) {
    manager.updateQueueItem(id, { status: "failed", error: err.message, failedAt: new Date().toISOString() });
    return manager.getQueueItem(id);
  }
  if (!creds) {
    manager.updateQueueItem(id, {
      status: item.autoUpload ? "waiting_credentials" : "failed",
      error: "Bilibili is not logged in",
    });
    return manager.getQueueItem(id);
  }
  let recording = item.recordingId ? manager.getRecording(item.recordingId) : null;
  const recovery = require("../recorder/replay-recovery");
  try {
    recovery.assertUploadReady(recording, { autoUpload: item.autoUpload === true, confirmLocal: item.confirmLocal === true });
  } catch (err) {
    manager.updateQueueItem(id, { status: "failed", error: err.message, failedAt: new Date().toISOString() });
    return manager.getQueueItem(id);
  }
  if (recording && path.extname(recording.filePath || "").toLowerCase() !== ".mp4") {
    try {
      recording = await require("../recorder/archive-processor").prepareForUpload(recording.id);
      const stat = fs.statSync(recording.filePath);
      item.file = recording.filePath;
      item.archiveVersion = Number(recording.archiveVersion) || 0;
      item.fileFingerprint = { size: stat.size, mtimeMs: stat.mtimeMs };
      item.fileSha256 = recording.fileSha256 || null;
      manager.updateQueueItem(id, { recordingId: recording.id, file: recording.filePath, title: recording.title,
        archiveVersion: Number(recording.archiveVersion) || 0,
        fileFingerprint: { size: stat.size, mtimeMs: stat.mtimeMs }, fileSha256: recording.fileSha256 || null,
        uposFilename: null, uposBizId: null, uploadedAt: null });
    } catch (err) {
      manager.updateQueueItem(id, { status: "failed", error: `MP4 归档失败: ${err.message}`, failedAt: new Date().toISOString() });
      return manager.getQueueItem(id);
    }
  }
  const sameFile = recording && path.resolve(recording.filePath || "") === path.resolve(item.file || "");
  const currentVersion = Number(recording?.archiveVersion) || 0;
  let currentStat = null;
  try { currentStat = item.file && fs.statSync(item.file); } catch {}
  const sameVersion = recording && currentVersion === (Number(item.archiveVersion) || 0);
  const sameFingerprint = currentStat && (!item.fileFingerprint || (Number(item.fileFingerprint.size) === currentStat.size && Number(item.fileFingerprint.mtimeMs) === currentStat.mtimeMs));
  if (!recording || recording.status !== "done" || !sameFile || !sameVersion || !sameFingerprint || !item.file || !currentStat) {
    manager.updateQueueItem(id, { status: "failed", error: "Recording file not found" });
    return manager.getQueueItem(id);
  }
  if (!item.manualReupload && (recording.uploadStatus === "done" || recording.draftId || findCompletedUpload(recording.id))) {
    manager.updateQueueItem(id, { status: "failed", error: "该录像已上传，请勿重复上传" });
    return manager.getQueueItem(id);
  }
  if (item.manualReupload && (String(recording.uploadJobId) !== String(item.id) || recording.uploadStatus === "done" || recording.draftId || recording.bvid || recording.uploadMode === "publish")) {
    manager.updateQueueItem(id, { status: "failed", error: "该重投稿任务已过期或 B站已有新稿，已停止重复投稿" });
    return manager.getQueueItem(id);
  }
  const uploadedAtMs = Date.parse(item.uploadedAt || "");
  const canReuseUploaded = Boolean(
    item.uposFilename &&
    item.uposBizId !== undefined &&
    Number.isFinite(uploadedAtMs) &&
    Date.now() - uploadedAtMs < REUSABLE_UPOS_MS
  );
  manager.updateQueueItem(id, {
    status: "uploading",
    error: null,
    startedAt: new Date().toISOString(),
    progress: canReuseUploaded ? 100 : 0,
  });
  try {
    const digest = require("../recorder/replay-download").digest;
    const actualSha256 = await digest(item.file);
    if (item.fileSha256 && item.fileSha256 !== actualSha256) throw new Error("录像文件版本已变化，请重新创建投稿任务");
    manager.updateQueueItem(id, { fileSha256: actualSha256 });
    const covers = require("../recorder/covers");
    recording = await covers.generate(recording, { allowQueued: true });
    const cover = await biliDraft.uploadCover({ filePath: covers.file(recording.coverFile), cookie: creds.cookie, csrf: creds.csrf });
    manager.updateQueueItem(id, { cover });
    const meta = {
      title: item.title || path.basename(item.file, path.extname(item.file)),
      tid: item.tid || 171,
      tag: item.tags || "SNH48,直播",
      desc: item.desc || "",
      copyright: item.copyright || 1,
      source: "",
      cover,
      dynamic: item.dynamic || "",
    };
    const uploaded = canReuseUploaded
      ? { filename: item.uposFilename, bizId: item.uposBizId }
      : await biliDraft.uploadFileToUpos({
          filePath: item.file,
          cookie: creds.cookie,
          upcdn: process.env.BILI_UPCDN || "bda2",
          onProgress: (ratio) => manager.updateQueueItem(id, { progress: Math.round(ratio * 100) }),
          beforeChunk: async () => {
            const current = manager.getRecording(item.recordingId);
            let stat = null; try { stat = fs.statSync(item.file); } catch {}
            if (!current || path.resolve(current.filePath || "") !== path.resolve(item.file || "")
              || (Number(current.archiveVersion) || 0) !== (Number(item.archiveVersion) || 0)
              || !stat || Number(item.fileFingerprint?.size) !== stat.size || Number(item.fileFingerprint?.mtimeMs) !== stat.mtimeMs) {
              throw new Error("录像文件版本已变化，已停止上传旧文件");
            }
            return waitForRecordingToFinish(id);
          },
        });
    if (!canReuseUploaded) {
      manager.updateQueueItem(id, {
        progress: 100,
        uposFilename: uploaded.filename,
        uposBizId: uploaded.bizId,
        uposUri: uploaded.uposUri,
        uploadId: uploaded.uploadId,
        uploadedAt: new Date().toISOString(),
      });
    }
    const latestRecording = manager.getRecording(item.recordingId);
    const latestStat = (() => { try { return fs.statSync(item.file); } catch { return null; } })();
    const latestSha256 = latestStat ? await digest(item.file) : null;
    if (!latestRecording || path.resolve(latestRecording.filePath || "") !== path.resolve(item.file || "")
      || (Number(latestRecording.archiveVersion) || 0) !== (Number(item.archiveVersion) || 0)
      || !latestStat || Number(item.fileFingerprint?.size) !== latestStat.size
      || Number(item.fileFingerprint?.mtimeMs) !== latestStat.mtimeMs || latestSha256 !== actualSha256) {
      throw new Error("录像文件版本已变化，已停止提交旧文件");
    }
    const video = { filename: uploaded.filename, title: meta.title, desc: "", bizId: uploaded.bizId || 0 };
    let result;
    if (item.mode === "publish") {
      result = await biliDraft.publishArchive({ meta, video, cookie: creds.cookie, csrf: creds.csrf });
    } else {
      result = await biliDraft.saveDraft({ meta, video, cookie: creds.cookie, csrf: creds.csrf, format: "auto" });
    }
    manager.updateQueueItem(id, {
      status: "done",
      error: null,
      failedAt: null,
      progress: 100,
      completedAt: new Date().toISOString(),
      draftId: result.draftId || null,
      aid: result.aid || null,
      bvid: result.bvid || (result.raw && result.raw.data && result.raw.data.bvid) || null,
    });
    manager.updateRecording(item.recordingId, {
      uploadStatus: "done",
      uploadMode: item.mode,
      uploadJobId: item.id,
      draftId: result.draftId || null,
      bvid: result.bvid || null,
      uploadHistory: item.manualReupload ? [...(manager.getRecording(item.recordingId)?.uploadHistory || []), {
        type: "manual_reupload_completed",
        jobId: item.id,
        draftId: result.draftId || null,
        aid: result.aid || null,
        bvid: result.bvid || null,
        completedAt: new Date().toISOString(),
      }] : manager.getRecording(item.recordingId)?.uploadHistory,
    });
  } catch (err) {
    manager.updateQueueItem(id, {
      status: "failed",
      error: err.message,
      failedAt: new Date().toISOString(),
    });
    if (item.recordingId) manager.updateRecording(item.recordingId, { uploadStatus: "failed", uploadJobId: item.id });
  } finally {
    running.delete(id);
    setImmediate(pump);
  }
  return manager.getQueueItem(id);
}

function retry(id) {
  const item = manager.getQueueItem(id);
  if (!item) throw new Error("Upload queue item not found");
  if (item.status === "uploading" || running.has(id)) throw new Error("Upload is already running");
  const recording = item.recordingId ? manager.getRecording(item.recordingId) : null;
  const manualReupload = item.manualReupload === true;
  if (manualReupload && (!recording || String(recording.uploadJobId) !== String(item.id))) {
    throw uploadError("该重投稿任务已过期，录像已有更新的投稿任务", 409, "REUPLOAD_STALE");
  }
  if (manualReupload) {
    const activeOther = manager.getQueue().find(candidate => String(candidate.recordingId) === String(item.recordingId)
      && candidate.id !== item.id && ACTIVE_UPLOAD_STATUSES.has(candidate.status));
    if (activeOther) throw uploadError("该录像已有其他投稿任务正在进行，请稍后重试", 409, "REUPLOAD_ACTIVE", activeOther);
  }
  const completed = item.status === "done" ? item : (manualReupload ? null : findCompletedUpload(item.recordingId));
  if (completed || (recording && (recording.uploadStatus === "done" || recording.draftId || recording.bvid || recording.uploadMode === "publish"))) {
    throw alreadyUploadedError(completed);
  }
  manager.updateQueueItem(id, {
    status: "queued",
    error: null,
    progress: item.uposFilename ? 100 : 0,
    retries: Number(item.retries || 0) + 1,
  });
  schedule(id);
  return manager.getQueueItem(id);
}

// Restart recovery: a previous process may have died with durable queue work in
// any active status. Items this process is actively uploading (or holding paused
// behind a recording) are skipped, so the call stays safe at any time — startup
// recovery can never clobber a live upload or fabricate a restart error for it.
function resumeQueued() {
  for (const item of manager.getQueue()) {
    if (!ACTIVE_UPLOAD_STATUSES.has(item.status) || running.has(item.id)) continue;
    manager.updateQueueItem(item.id, { status: "queued", error: item.status === "uploading" ? "Server restarted during upload" : item.error });
    schedule(item.id);
  }
}

// Credentials became available without a restart (QR login, or a restored cookies
// volume confirmed by an authenticated /status poll). Only wake tasks parked on
// missing credentials and re-kick the pump for already queued work; uploading and
// paused_recording items are never touched and no synthetic error is written.
function resumeWaitingForCredentials() {
  for (const item of manager.getQueue()) {
    if (item.status === "waiting_credentials") {
      manager.updateQueueItem(item.id, { status: "queued", error: null });
      schedule(item.id);
    } else if (item.status === "queued") {
      schedule(item.id);
    }
  }
}

function isUploadInFlight(id) { return running.has(id); }

// Queue item updates fire on every upload progress tick. When an update would
// not change any value, skip the full upload_queue.json rewrite and the SSE
// broadcast; only genuinely new values are persisted.
const rawUpdateQueueItem = manager.updateQueueItem;
manager.updateQueueItem = (id, updates) => {
  const item = manager.getQueueItem(id);
  if (item && Object.entries(updates || {}).every(([key, value]) => item[key] === value)) return item;
  return rawUpdateQueueItem(id, updates);
};

// Run restart recovery once per process at first load so persisted queue work is
// revived without waiting for the first HTTP poll; resumeQueued() stays safe to
// call again (e.g. from the index.js server startup) because in-flight items are
// skipped and unchanged items are not rewritten.
resumeQueued();

module.exports = {
  COOKIES_PATH,
  getCredentials,
  enqueueRecording,
  enqueueReuploadRecording,
  processItem,
  retry,
  resumeQueued,
  resumeWaitingForCredentials,
  isUploadInFlight,
  setRecordingActive,
  toQueueDto,
  summarizeQueue,
  _internals: { normalizeMode, buildItem, running, safeBaseName, pump, UPLOAD_CONCURRENCY, waitForRecordingToFinish, isRecordingActive: () => recordingActive, findCompletedUpload, alreadyUploadedError },
};
