"use strict";

// Manual rescue for a missed Pocket48 session. A verified MP4 becomes a
// recording only after the complete download has passed its media checks.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("../../lib/store");
const manager = require("./manager");
const recorder = require("../pocket48/recorder");
const replay = require("../pocket48/replay");
const media = require("./replay-download");
const uploadQueue = require("../bilibili/queue");
const recovery = require("./replay-recovery");

const KEY = "replay_import_jobs";
const MAX_JOBS = 100;
const ACTIVE = new Set(["pending", "querying", "downloading", "verifying", "archiving"]);
const saved = store.load(KEY, []);
const jobs = new Map((Array.isArray(saved) ? saved : []).map(item => [item.id,
  ACTIVE.has(item.status) ? { ...item, status: "failed", error: "服务重启中断了导入，请重新提交直播 ID", updatedAt: new Date().toISOString() } : item]));
const activeLives = new Set();

function persist() {
  const recent = [...jobs.values()].slice(-MAX_JOBS);
  for (const key of [...jobs.keys()].slice(0, Math.max(0, jobs.size - MAX_JOBS))) jobs.delete(key);
  media.atomicJson(store.filePath(KEY), recent);
}
if (Array.isArray(saved) && saved.some(item => ACTIVE.has(item.status))) persist();

function problem(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
function validLiveId(value) {
  const liveId = String(value ?? "").trim();
  if (!/^\d{1,30}$/.test(liveId)) throw problem("请输入有效的数字直播 ID", 400, "INVALID_LIVE_ID");
  return liveId;
}
function existingArchive(liveId) {
  return manager.getRecordings().find(rec => String(rec.liveId) === liveId
    && rec.status === "done" && rec.filePath && fs.existsSync(rec.filePath)) || null;
}
function patch(id, values) {
  const current = jobs.get(id);
  if (!current) return null;
  const next = { ...current, ...values, updatedAt: new Date().toISOString() };
  jobs.set(id, next);
  persist();
  return next;
}
function visible(job) {
  if (!job) return null;
  const { id, liveId, status, progress, error, recordingId, uploadQueued, uploadJobId, title, updatedAt } = job;
  return { id, liveId, status, progress, error, recordingId, uploadQueued, uploadJobId, title, updatedAt };
}
function get(id) { return visible(jobs.get(String(id)) || null); }
function startedAt(value) {
  const raw = String(value || "");
  const parsed = /^\d{10,13}$/.test(raw) ? new Date(Number(raw) * (raw.length === 10 ? 1000 : 1)) : new Date(raw);
  // Returning "now" here silently stamped the import date onto a live that aired
  // days earlier: a 2026-10-25 backfill was titled "2026-10-26-...". Null lets the
  // caller look the real time up from the replay list before archiving.
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
// The single-replay endpoint returns an EMPTY member object and no start time, so
// an import that trusts it archives the live as "Pocket48" with today's date. The
// paged replay list carries both, and paging further than the default 12 pages is
// what locates older lives.
async function lookupInList(liveId, { maxPages = 40 } = {}) {
  let next = "0";
  for (let page = 0; page < maxPages; page += 1) {
    const result = await replay.listReplays({ next }).catch(() => null);
    const list = result?.list || [];
    if (!list.length) return null;
    const hit = list.find((item) => String(item.liveId || item.id || "") === liveId);
    if (hit) return hit;
    next = String(result.next || "");
    if (!next || next === "0") return null;
  }
  return null;
}
function memberOf(detail) { return detail?.member || {}; }

async function run(id, { liveId, memberId, title, autoUpload }) {
  let directory;
  try {
    patch(id, { status: "querying" });
    // Prefer the member replay list when the caller supplied a member ID. This
    // avoids an unnecessary single-replay request and gives the UI the same
    // exact live ID matching used by historical audit. If no member ID was
    // supplied, use the detail endpoint once to discover it, then query the
    // list when possible. The downloader performs its own final stream lookup.
    let detail = null;
    let metadata = memberId ? await replay.findReplayMetadata(liveId, memberId).catch(() => null) : null;
    if (!metadata) detail = await replay.getReplay(liveId);
    let actualMemberId = String(memberId || memberOf(detail?.replay).id || "");
    if (!metadata && actualMemberId) metadata = await replay.findReplayMetadata(liveId, actualMemberId).catch(() => null);
    if (metadata && String(metadata.liveId) !== liveId) metadata = null;
    if (!metadata && !detail?.replay) throw problem("未找到该场直播的官方回放记录", 404, "REPLAY_UNAVAILABLE");
    // The detail endpoint often reports neither the member nor the start time. The
    // paged list has both, and without them the archive is mislabelled.
    if (!memberOf(metadata || {}).id || !memberOf(metadata || {}).name || !(metadata || {}).startedAt) {
      const listed = await lookupInList(liveId);
      if (listed) metadata = { ...(metadata || {}), ...listed };
    }
    const info = { ...(detail?.replay || {}), ...(metadata || {}) };
    if (!info.liveId) info.liveId = liveId;
    // Re-derive after the list lookup: the member was unknown until just now.
    actualMemberId = String(memberId || memberOf(info).id || "");
    const name = memberOf(info).name || memberOf(detail?.replay).name || "Pocket48";
    const time = startedAt(info.startedAt) || new Date().toISOString();
    const archiveTitle = title || recorder._internals.recordingTitle({ startedAt: time, memberName: name, liveTitle: info.title });
    directory = recovery._internals.directory(liveId);
    patch(id, { status: "downloading", title: archiveTitle });
    let lastProgress = 0;
    const official = await media.downloadShared({ liveId, directory, verify: true, onProgress(progress) {
      const now = Date.now();
      if (now - lastProgress < 1000 && !progress.verifying) return;
      lastProgress = now;
      patch(id, { status: progress.verifying ? "verifying" : "downloading",
        progress: progress.verifying ? 99 : Math.min(98, Math.floor((progress.completed || 0) / Math.max(1, progress.total || 1) * 98)) });
    } });
    if (String(official.liveId) !== liveId || official.verification !== "full" || !(Number(official.durationSeconds) > 0)
      || !official.streams?.some(stream => stream.codec_type === "video") || !official.filePath
      || !fs.existsSync(official.filePath) || !/^[a-f0-9]{64}$/i.test(String(official.sha256 || ""))) {
      throw problem("官方回放完整校验未通过，不能建立录像归档", 422, "REPLAY_NOT_VERIFIED");
    }
    const realRoot = fs.realpathSync(recorder._internals.recordingsDir());
    const realFile = fs.realpathSync(official.filePath);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.lstatSync(official.filePath).isFile() || await media.digest(realFile) !== official.sha256) {
      throw problem("回放文件路径或 SHA-256 校验失败，不能建立录像归档", 422, "REPLAY_NOT_VERIFIED");
    }
    patch(id, { status: "archiving", progress: 99 });
    const duplicate = existingArchive(liveId);
    if (duplicate) throw problem("该直播场次已有有效录像归档", 409, "ARCHIVE_EXISTS");
    const recording = manager.addRecording({
      source: "pocket48", liveId, title: archiveTitle, liveTitle: info.title || "直播",
      memberId: actualMemberId, memberName: name, liveCoverUrl: info.cover || "",
      memberAvatarUrl: memberOf(info).avatar || memberOf(detail?.replay).avatar || "",
      startedAt: time, endedAt: new Date(Date.parse(time) + official.durationSeconds * 1000).toISOString(),
      status: "done", mediaType: "video", container: "mp4", filePath: realFile,
      fileName: `${recorder._internals.safeName(archiveTitle)}.mp4`,
      size: official.size, fileSize: official.size, duration: official.durationSeconds,
      durationSeconds: official.durationSeconds, fileSha256: official.sha256,
      archiveOrigin: "official_replay", archiveVersion: 1,
      replayRecovery: { status: "replaced", qualityGate: { status: "passed", source: "official_replay" },
        replacedAt: new Date().toISOString(), message: "已完整下载并校验官方回放" },
      manualReplayImport: true, autoUpload: autoUpload === true,
    });
    let uploadQueued = false, uploadJobId = null, uploadError = null;
    if (autoUpload) {
      try {
        const upload = uploadQueue.enqueueRecording(recording.id, { mode: "draft", title: archiveTitle, autoUpload: true });
        uploadQueued = true; uploadJobId = upload.id;
      } catch (error) {
        uploadError = `录像已归档，但加入 B站草稿队列失败：${error.message}`;
      }
    }
    patch(id, { status: "done", progress: 100, recordingId: recording.id, error: uploadError,
      uploadQueued, uploadJobId });
  } catch (error) {
    const safeMessage = /^[\u4e00-\u9fff]/.test(String(error.message || "")) ? error.message : "官方回放导入失败，请稍后重试";
    patch(id, { status: "failed", error: safeMessage });
    if (directory) { try { media.cleanupTransient(directory); } catch {} }
  } finally { activeLives.delete(liveId); }
}

// Same contract as upstream `repository.create_or_get_job`: submitting the same
// live id twice returns the existing unfinished job instead of starting a second
// download. Passing `idempotent: false` keeps the old throwing behaviour so a
// manual retry still surfaces its 409.
function enqueue(input = {}) {
  const liveId = validLiveId(input.liveId);
  const memberId = input.memberId == null || input.memberId === "" ? "" : String(input.memberId).trim();
  if (memberId && !/^\d{1,30}$/.test(memberId)) throw problem("成员 ID 必须是数字", 400, "INVALID_MEMBER_ID");
  const title = String(input.title || "").trim();
  if (title.length > 200) throw problem("标题不能超过 200 字", 400, "TITLE_TOO_LONG");
  if (input.autoUpload != null && typeof input.autoUpload !== "boolean") throw problem("自动投稿参数无效", 400, "INVALID_AUTO_UPLOAD");
  if (input.idempotent !== false) {
    const existing = activeFor(liveId);
    if (existing) return visible(existing);
  }
  if (activeLives.has(liveId)) throw problem("该直播场次已在导入中", 409, "IMPORT_ACTIVE");
  const duplicate = existingArchive(liveId);
  if (duplicate) throw problem("该直播场次已有有效录像归档", 409, "ARCHIVE_EXISTS");
  if (recorder.listActive().some(item => String(item.liveId) === liveId)) throw problem("该场直播仍在录制，请等待结束", 409, "LIVE_RECORDING_ACTIVE");
  const id = `import_${crypto.randomUUID()}`;
  jobs.set(id, { id, liveId, status: "pending", progress: 0, error: null, recordingId: null,
    uploadQueued: false, uploadJobId: null, title: title || "", updatedAt: new Date().toISOString() });
  persist(); activeLives.add(liveId);
  setImmediate(() => { void run(id, { liveId, memberId, title, autoUpload: input.autoUpload === true }); });
  return get(id);
}

function activeFor(liveId) {
  const id = String(liveId || "");
  return [...jobs.values()].find(job => job.liveId === id && ACTIVE.has(job.status)) || null;
}

// Every live id with a job that has not settled yet, for the replay watch dedupe.
function activeLiveIds() { return [...activeLives]; }
module.exports = { enqueue, get, activeFor, activeLiveIds, _internals: { jobs, activeLives, run, existingArchive } };
