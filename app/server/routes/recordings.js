"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const manager = require("../modules/recorder/manager");
const pocketRecorder = require("../modules/pocket48/recorder");
const uploadQueue = require("../modules/bilibili/queue");
const archiveProcessor = require("../modules/recorder/archive-processor");

const diskStorage = require("../modules/recorder/storage");
const backupLeases = require("../modules/backup115/leases");
const covers = require("../modules/recorder/covers");
const replayRecovery = require("../modules/recorder/replay-recovery");
const replayAudit = require("../modules/recorder/replay-audit");
const biliDraft = require("../modules/bilibili/draft");
const replayImport = require("../modules/recorder/replay-import");

const router = express.Router();
const reuploading = new Set();

async function listAllDrafts(credentials, { pageSize = 100, maxPages = 20 } = {}) {
  const drafts = [];
  for (let pn = 1; pn <= maxPages; pn += 1) {
    const page = await biliDraft.listDrafts({ cookie: credentials.cookie, pn, ps: pageSize, timeoutMs: 15_000 });
    drafts.push(...page);
    if (page.length < pageSize) return drafts;
  }
  // A full page at the safety limit is ambiguous: fail closed rather than
  // allowing a duplicate when an older draft may be on a later page.
  throw new Error("B站草稿列表过多，无法确认是否存在旧稿，请稍后重试");
}

function findKnownDraft(drafts, recording, queueItems) {
  const knownIds = new Set([
    recording.draftId,
    ...queueItems.map(item => item.draftId),
    ...(Array.isArray(recording.uploadHistory) ? recording.uploadHistory.map(item => item.previousDraftId || item.draftId) : []),
  ].filter(value => value !== null && value !== undefined && String(value)).map(String));
  const knownBizIds = new Set(queueItems.map(item => Number(item.uposBizId)).filter(Number.isSafeInteger));
  return drafts.find(item => knownIds.has(String(item.draftId)) || (Number.isSafeInteger(item.videoCid) && knownBizIds.has(item.videoCid))) || null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function fileError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveRecordingFile(recording) {
  if (!recording?.filePath) throw fileError("Recording file not found", 404);
  const root = path.resolve(pocketRecorder._internals.recordingsDir());
  const candidate = path.resolve(recording.filePath);
  if (!isInside(root, candidate)) {
    throw fileError("Recording file is outside the recordings directory", 400);
  }
  if (!fs.existsSync(candidate)) throw fileError("Recording file not found", 404);
  const rootReal = fs.realpathSync(root);
  const candidateReal = fs.realpathSync(candidate);
  if (!isInside(rootReal, candidateReal)) {
    throw fileError("Recording file is outside the recordings directory", 400);
  }
  if (!fs.lstatSync(candidate).isFile()) {
    throw fileError("Recording path is not a regular file", 400);
  }
  return candidateReal;
}

function deleteRecordingFile(recording) {
  if (!recording.filePath) return false;
  const root = path.resolve(pocketRecorder._internals.recordingsDir());
  const candidate = path.resolve(recording.filePath);
  if (!isInside(root, candidate)) {
    throw fileError("Recording file is outside the recordings directory", 400);
  }
  if (!fs.existsSync(candidate)) return false;
  const filePath = resolveRecordingFile(recording);
  if (backupLeases.lockedPath(filePath)) throw fileError("115备份正在使用该文件，请先取消115备份后再删除", 409);
  fs.unlinkSync(filePath);
  return true;
}

function recordingFile(req, res, download = false) {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  try {
    const filePath = resolveRecordingFile(recording);
    if (download) return res.download(filePath, path.basename(recording.fileName || filePath));
    res.type(path.extname(filePath).toLowerCase() === '.m4a' ? 'audio/mp4' : path.extname(filePath).toLowerCase() === ".mp4" ? "video/mp4" : "video/x-flv");
    return res.sendFile(filePath);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
}

router.get("/", (req, res) => {
  const { status, source, limit } = req.query;
  const list = manager.getRecordings({ status, source, limit: Number(limit) || 0 });
  // total is the filtered count before the limit is applied, so the dashboard can
  // show real totals while still fetching a small page.
  const total = manager.getRecordings({ status, source }).length;
  res.json({ success: true, data: list, meta: { total } });
});

router.get("/storage", async (_req, res) => {
  try {
    const data = await diskStorage.inventory(path.resolve(pocketRecorder._internals.recordingsDir()), { cache: true });
    res.json({ success: true, data: { ...data, files: data.files.map(({ filePath, ...file }) => file) } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete("/storage/:fileId", async (req, res) => {
  try {
    // Deletion decisions must not be based on a stale cached inventory.
    const data = await diskStorage.inventory(path.resolve(pocketRecorder._internals.recordingsDir()));
    const file = data.files.find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ success: false, error: "文件不存在，请刷新清单" });
    if (backupLeases.lockedPath(file.filePath)) return res.status(409).json({ success: false, error: "115备份正在使用该文件，请先取消115备份后再清理" });
    if (file.locked || file.kind === "main") return res.status(409).json({ success: false, error: "主文件请从归档列表删除；使用中的文件暂不可清理" });
    deleteRecordingFile(file);
    // Keep the polling inventory consistent with what is actually on disk.
    diskStorage.invalidate(path.resolve(pocketRecorder._internals.recordingsDir()));
    res.json({ success: true, data: { fileDeleted: true } });
  } catch (err) { res.status(err.statusCode || 500).json({ success: false, error: err.message }); }
});

// Keep named collection routes before /:id.
router.get("/replay-audit", (_req, res) => res.json({ success: true, data: replayAudit.summary() }));
router.post("/replay-audit/scan", (req, res) => {
  void replayAudit.scan({ days: req.body?.days, limit: req.body?.limit, autoRepair: req.body?.autoRepair !== false }).catch(() => {});
  res.status(202).json({ success: true, data: replayAudit.summary() });
});
router.post("/replay-audit/:id/repair", (req, res) => {
  try {
    const job = replayAudit.repair(req.params.id, { force: req.body?.force === true });
    void job.catch(() => {});
    res.status(202).json({ success: true, data: replayAudit.summary() });
  } catch (error) { res.status(error.statusCode || 409).json({ success: false, error: error.message }); }
});

// Manually rescue a missed session from the official Pocket48 replay. The job
// is deliberately asynchronous because HLS download and full media validation
// can take several minutes.
router.post("/replay-import", (req, res) => {
  try { return res.status(202).json({ success: true, data: replayImport.enqueue(req.body || {}) }); }
  catch (error) { return res.status(error.statusCode || 400).json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) }); }
});
router.get("/replay-import/:jobId", (req, res) => {
  const job = replayImport.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "导入任务不存在" });
  return res.json({ success: true, data: job });
});

// Re-submit a locally repaired archive only after the current Bilibili account
// has been checked. A stale local draftId is upload history, not proof that a
// draft still exists upstream; conversely, an empty draft list alone is not a
// proof that an older upload was never published.
router.post("/:id/reupload", async (req, res) => {
  const id = String(req.params.id || "");
  if (req.body?.confirmed !== true) return res.status(400).json({ success: false, error: "请先确认 B站草稿已不存在，并确认要重新投稿" });
  const recording = manager.getRecording(id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  if (reuploading.has(id)) return res.status(409).json({ success: false, error: "该录像正在核实 B站状态，请勿重复操作" });
  if (recording.replayAudit?.status !== "repaired_local_published") {
    return res.status(409).json({ success: false, code: "REUPLOAD_REPAIR_REQUIRED", error: "仅允许对已修复的历史投稿录像重新投稿" });
  }
  const historical = manager.getQueue().filter(item => String(item.recordingId) === id);
  const published = recording.bvid || recording.uploadMode === "publish" || historical.some(item => item.status === "done" && (item.mode === "publish" || item.bvid));
  if (published) return res.status(409).json({ success: false, code: "REUPLOAD_PUBLISHED", error: "该录像已有已发布的 B站稿件，不能按草稿重新投稿" });
  if (historical.some(item => ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(item.status))) {
    return res.status(409).json({ success: false, code: "REUPLOAD_ACTIVE", error: "该录像已有投稿任务正在进行，请勿重复操作" });
  }
  let creds;
  try { creds = uploadQueue.getCredentials(); }
  catch { return res.status(401).json({ success: false, errorCode: "BILIBILI_LOGIN_REQUIRED", error: "B站登录凭据无效，请重新扫码登录" }); }
  if (!creds) return res.status(401).json({ success: false, errorCode: "BILIBILI_LOGIN_REQUIRED", error: "B站账号未登录，请先在「B站草稿」页扫码绑定" });
  reuploading.add(id);
  try {
    let drafts;
    try {
      drafts = await listAllDrafts(creds);
    } catch (error) {
      return res.status(502).json({ success: false, code: "REUPLOAD_DRAFT_CHECK_FAILED", error: `无法核实 B站草稿列表：${error.message}` });
    }
    const existing = findKnownDraft(drafts, recording, historical);
    if (existing) {
      return res.status(409).json({ success: false, code: "REUPLOAD_DRAFT_EXISTS", error: "B站草稿仍存在，请在创作中心编辑或发布，不要重复投稿", data: { draftId: existing.draftId } });
    }
    const item = uploadQueue.enqueueReuploadRecording(id, { title: recording.title });
    return res.status(202).json({ success: true, data: uploadQueue.toQueueDto(item) });
  } catch (error) {
    const status = error.statusCode || 409;
    const body = { success: false, error: error.message };
    if (error.code) body.code = error.code;
    if (error.existingItem) body.data = uploadQueue.toQueueDto(error.existingItem);
    return res.status(status).json(body);
  } finally {
    reuploading.delete(id);
  }
});

router.get("/cover-settings", (_req, res) => res.json({ success: true, data: { ...covers.settings(), members: covers.members() } }));
router.put("/cover-settings", (req, res) => {
  try { res.json({ success: true, data: covers.saveSettings(req.body || {}) }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
router.put("/cover-members/:memberId", async (req, res) => {
  try { res.json({ success: true, data: await covers.saveMember(req.params.memberId, req.body || {}) }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
router.get("/cover-members/:memberId/photo", (req, res) => {
  const member = covers.settings().members.find(m => m.memberId === req.params.memberId);
  if (!member?.photoFile) return res.sendStatus(404);
  res.sendFile(covers.file(member.photoFile));
});
router.get("/cover-batch", (_req, res) => res.json({ success: true, data: covers.batch }));
router.post("/cover-batch", (req, res) => {
  try { res.status(202).json({ success: true, data: covers.startBatch(req.body?.ids) }); }
  catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
router.get("/templates", (_req, res) => res.json({ success: true, data: manager.getTemplates() }));

router.post("/templates", (req, res) => {
  const templates = manager.getTemplates();
  const template = { id: `tpl_${Date.now()}`, createdAt: new Date().toISOString(), ...req.body };
  templates.unshift(template);
  manager.saveTemplates(templates);
  res.status(201).json({ success: true, data: template });
});

router.put("/templates/:id", (req, res) => {
  const templates = manager.getTemplates();
  const template = templates.find((item) => item.id === req.params.id);
  if (!template) return res.status(404).json({ success: false, error: "Template not found" });
  Object.assign(template, req.body, { id: template.id });
  manager.saveTemplates(templates);
  res.json({ success: true, data: template });
});

router.delete("/templates/:id", (req, res) => {
  const templates = manager.getTemplates();
  const index = templates.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ success: false, error: "Template not found" });
  const [removed] = templates.splice(index, 1);
  manager.saveTemplates(templates);
  res.json({ success: true, data: removed });
});

router.get("/:id", (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  res.json({ success: true, data: recording });
});

router.post("/:id/cover-candidates", async (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  try {
    covers.assertEditable(recording);
    const candidates = await covers.prepare(recording, { refresh: req.body?.refresh === true });
    res.json({ success: true, data: covers.candidateList(recording, candidates) });
  } catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
});
router.get("/:id/cover-candidates/:file", (req, res) => {
  const recording = manager.getRecording(req.params.id);
  const candidate = recording?.coverCandidates?.find(c => c.file === req.params.file);
  if (!candidate || recording.status !== "done") return res.sendStatus(404);
  res.sendFile(covers.file(candidate.file));
});
router.get("/:id/cover", (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording?.coverFile) return res.sendStatus(404);
  res.set("Cache-Control", "private, no-cache");
  res.sendFile(covers.file(recording.coverFile));
});
router.post("/:id/cover", async (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  const active = manager.getQueue().some(item => item.recordingId === recording.id && ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(item.status));
  if (active) return res.status(409).json({ success: false, error: "请等待上传队列完成后再修改封面" });
  if (recording.uploadStatus === "done" && !recording.draftId) return res.status(409).json({ success: false, error: "该投稿没有关联的 B站草稿，请前往创作中心修改" });
  try {
    const result = await covers.generate(recording, { next: req.body?.next === true, image: req.body?.image, source: req.body?.source, candidateFile: req.body?.candidateFile, refresh: req.body?.refresh === true });
    res.json({ success: true, data: result });
  } catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }
});

router.get("/:id/file", (req, res) => recordingFile(req, res));

const coverSyncing = new Set();
router.post("/:id/cover-sync", async (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  if (coverSyncing.has(recording.id)) return res.status(409).json({ success: false, error: "封面正在同步，请稍后重试" });
  coverSyncing.add(recording.id);
  try {
    covers.assertEditable(recording);
    if (!recording.draftId || !recording.coverFile) throw new Error("没有关联的 B站草稿或本地封面");
    const creds = uploadQueue.getCredentials();
    if (!creds) { const error = new Error("请先登录 B站"); error.statusCode = 401; throw error; }
    const coverFile = recording.coverFile;
    const bili = require("../modules/bilibili/draft");
    const cover = await bili.uploadCover({ filePath: covers.file(coverFile), cookie: creds.cookie, csrf: creds.csrf });
    const result = await bili.updateDraftCover({ draftId: recording.draftId, cover, ...creds, beforeWrite: detail => {
      require("../lib/store").save(`cover_draft_backup_${recording.id}`, { draftId: recording.draftId, detail, savedAt: new Date().toISOString() });
    } });
    manager.updateRecording(recording.id, { coverSyncedFile: coverFile, coverSyncPending: recording.coverFile !== coverFile, coverSyncedAt: new Date().toISOString() });
    res.json({ success: true, data: result });
  } catch (error) { res.status(error.statusCode || 502).json({ success: false, error: error.message }); }
  finally { coverSyncing.delete(recording.id); }
});

router.get("/:id/download", (req, res) => recordingFile(req, res, true));
router.get("/:id/original-download", (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording || recording.archiveOrigin !== "official_replay") return res.status(404).json({ success: false, error: "原录像备份不存在" });
  try {
    const original = recording.sourceFiles?.find(file => path.resolve(file) !== path.resolve(recording.filePath));
    const filePath = resolveRecordingFile({ filePath: original });
    return res.download(filePath, path.basename(filePath));
  } catch (error) { return res.status(error.statusCode || 404).json({ success: false, error: error.message }); }
});
router.post("/:id/recover-replay", (req, res) => {
  try { res.status(202).json({ success: true, data: replayRecovery.enqueue(req.params.id) }); }
  catch (error) { res.status(error.statusCode || 409).json({ success: false, error: error.message }); }
});

router.patch("/:id", (req, res) => {
  const allowed = ["title", "note", "cover", "tags", "desc", "tid", "copyright"];
  const updates = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) updates[key] = req.body[key];
  const recording = manager.updateRecording(req.params.id, updates);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  res.json({ success: true, data: recording });
});

router.post("/:id/process", async (req, res) => {
  try {
    const recording = await archiveProcessor.prepareForUpload(req.params.id);
    res.status(202).json({ success: true, data: recording });
  } catch (err) {
    res.status(err.message === "Recording not found" ? 404 : 500).json({ success: false, error: err.message });
  }
});

router.post("/:id/upload", async (req, res) => {
  try {
    const current = manager.getRecording(req.params.id);
    if (replayRecovery.busy(req.params.id)) throw Object.assign(new Error("请等待官方回放下载、校验和对比完成"), { statusCode: 409 });
    const completed = uploadQueue._internals.findCompletedUpload(req.params.id);
    if (completed || current?.uploadStatus === "done" || current?.draftId) {
      throw uploadQueue._internals.alreadyUploadedError(completed);
    }
    const recording = await archiveProcessor.prepareForUpload(req.params.id);
    const item = uploadQueue.enqueueRecording(recording.id, { ...(req.body || {}), title: recording.title });
    res.status(202).json({ success: true, data: uploadQueue.toQueueDto(item) });
  } catch (err) {
    const status = err.statusCode || (err.message.includes("not found") ? 404 : 400);
    const body = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.existingItem) body.data = uploadQueue.toQueueDto(err.existingItem);
    res.status(status).json(body);
  }
});

router.delete("/:id", (req, res) => {
  const recording = manager.getRecording(req.params.id);
  if (!recording) return res.status(404).json({ success: false, error: "Recording not found" });
  if (backupLeases.lockedRecording(recording)) return res.status(409).json({ success: false, error: "115备份正在使用录像文件，请先取消115备份后再删除" });
  if (replayRecovery.busy(recording.id)) return res.status(409).json({ success: false, error: "请等待官方回放下载与对比完成后再删除" });
  if (replayAudit.busy(recording.id)) return res.status(409).json({ success: false, error: "请等待历史审计修复完成后再删除" });
  if (["recording", "waiting_merge", "processing"].includes(recording.status)) {
    return res.status(409).json({ success: false, error: "Stop the recording before deleting it" });
  }
  const activeUpload = manager.getQueue().find(item =>
    String(item.recordingId) === String(recording.id) &&
    ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(item.status)
  );
  if (activeUpload) return res.status(409).json({ success: false, error: "Wait for the upload to finish before deleting the recording" });
  try {
    const candidates = diskStorage.paths(recording);
    const others = manager.getRecordings({ includeDeleted: true, includeMerged: true })
      .filter(r => r.id !== recording.id && r.status !== "deleted" && r.status !== "merged");
    // Deleting an archive is never blocked by file sharing. Two archives of the
    // same live legitimately point at the same physical file — duplicate archives
    // both hold the official replay, and a replay replacement also records the
    // original MP4 in sourceFiles. Refusing the delete made those duplicates
    // impossible to clean up: each one blocked the other forever.
    //
    // The rule is therefore ownership, not existence: unlink a file only when no
    // other surviving archive references it. A file still referenced elsewhere is
    // detached from this record and left on disk for its remaining owner, so it
    // never becomes an orphan and never disappears under someone else's feet.
    const shared = new Set();
    for (const candidate of candidates) {
      if (others.some(r => diskStorage.paths(r).includes(candidate))) shared.add(candidate);
    }
    const owned = candidates.filter(candidate => !shared.has(candidate));
    // Validate every existing path before deleting any file.
    for (const filePath of owned) {
      const root = path.resolve(pocketRecorder._internals.recordingsDir());
      if (!isInside(root, filePath)) throw fileError("Recording file is outside the recordings directory", 400);
      if (fs.existsSync(filePath)) resolveRecordingFile({ filePath });
    }
    if (backupLeases.lockedRecording(recording)) throw fileError("115备份正在使用录像文件，请先取消115备份后再删除", 409);
    let fileDeleted = false;
    for (const filePath of owned) fileDeleted = deleteRecordingFile({ filePath }) || fileDeleted;
    const deletedAt = new Date().toISOString();
    manager.updateRecording(req.params.id, {
      status: "deleted",
      sourceFiles: [],
      filePath: null,
      size: 0,
      fileSize: 0,
      fileDeleted,
      sharedFilesKept: [...shared],
      deletedAt,
    });
    replayAudit.remove(recording.id);
    // Keep the polling inventory consistent with what is actually on disk.
    diskStorage.invalidate(path.resolve(pocketRecorder._internals.recordingsDir()));
    res.json({ success: true, data: { id: recording.id, fileDeleted, sharedFilesKept: [...shared], deletedAt } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports._internals = { isInside, resolveRecordingFile, deleteRecordingFile, listAllDrafts, findKnownDraft };
