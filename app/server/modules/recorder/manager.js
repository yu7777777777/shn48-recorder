"use strict";

const store = require("../../lib/store");
const sse = require("../../lib/sse");
// Outbound notification hooks are one-way: manager pushes lifecycle events out,
// notify never calls back into manager, so a notification failure (or the whole
// module) cannot disturb recording state.
const notify = require("../notify");

// Recording job queue with automatic retry and SSE broadcasting
const RECORDINGS_KEY = "recordings";
const QUEUE_KEY = "upload_queue";

let recordings = [];
let uploadQueue = [];
let uploadRunning = false;

function loadState() {
  recordings = store.load(RECORDINGS_KEY, []);
  uploadQueue = store.load(QUEUE_KEY, []);
  let changed = false;
  for (const recording of recordings) {
    if (recording.status === "recording") {
      recording.status = "failed";
      recording.interruptedByRestart = true;
      recording.error = "Server restarted before recording completed";
      recording.endedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveRecordings();
}

function saveRecordings() {
  // A replay replacement must never expose a half-written recording index.
  store.atomicWrite(store.filePath(RECORDINGS_KEY), recordings);
}
function saveQueue() { store.save(QUEUE_KEY, uploadQueue); }

// --- Recordings ---
// A live session is identified by its liveId, not by the ffmpeg child process
// that happens to be recording it. Only one index entry may own a session; extra
// entries for the same liveId are what produced duplicate archives after a
// restart, an exhausted reconnect chain, or two concurrent start requests.
const SESSION_DEDUPE_SOURCES = new Set(["pocket48"]);
const SESSION_TERMINAL_STATUSES = new Set(["deleted", "merged"]);

// Clips are derived from a parent recording and legitimately share its liveId.
function isSessionSegment(item) {
  return item?.source !== "clip" && item?.segment !== true;
}

function findSessionRecording({ liveId, source, mediaType }) {
  const id = String(liveId ?? "").trim();
  if (!id || id === "undefined" || id === "null") return null;
  return recordings.find(rec => String(rec.liveId || "") === id
    && rec.source === source
    && isSessionSegment(rec)
    && !SESSION_TERMINAL_STATUSES.has(rec.status)
    && (!mediaType || !rec.mediaType || rec.mediaType === mediaType)) || null;
}

function insertRecording(rec) {
  const r = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    status: "pending", // pending / recording / done / failed
    ...rec,
  };
  recordings.unshift(r);
  saveRecordings();
  sse.broadcast("recording-added", r);
  // Reconnect segments and clip rows are not new sessions; only a fresh session
  // row that already starts live counts as "开始录制".
  if (r.status === "recording" && r.segment !== true && r.source !== "clip") {
    notify.event("recording_started", { id: r.id, title: r.title, memberName: r.memberName, liveId: r.liveId, source: r.source });
  }
  return r;
}

// A liveId session may claim exactly one non-terminal archive owner. A further
// start for the same live attaches as a segment of that owner instead of opening
// a second archive, whatever path led here (restart, reconnect, manual + auto).
function addRecording(rec) {
  const ownSession = rec && SESSION_DEDUPE_SOURCES.has(rec.source) && isSessionSegment(rec);
  if (ownSession) {
    const owner = findSessionRecording(rec);
    if (owner) {
      const segment = insertRecording({
        ...rec,
        segment: true,
        sessionId: owner.id,
        claimKey: owner.claimKey || owner.id,
        startedAt: rec.startedAt || new Date().toISOString(),
      });
      sse.broadcast("recording-segment", { id: segment.id, sessionId: owner.id });
      return segment;
    }
    return insertRecording(rec);
  }
  return insertRecording(rec);
}

function updateRecording(id, updates) {
  const r = recordings.find(x => x.id === id);
  if (!r) return null;
  const previous = { ...r };
  Object.assign(r, updates);
  // Lifecycle notifications are decided BEFORE persisting so the one-shot
  // "archive announced" flag lands atomically with the transition itself.
  // 归档完成只在每条录像上通知一次：done → processing → done 的重新整理 MP4
  // 不重复打扰；归档失败时清除标记，之后的 done 作为"恢复"再通知一次。
  const notifyDone = r.source !== "clip" && r.status === "done" && previous.status !== "done" && !r.archiveNotified;
  const notifyFailed = r.source !== "clip" && (r.status === "failed" || r.status === "archive_failed") && previous.status !== r.status;
  const notifyStarted = r.source !== "clip" && r.status === "recording" && previous.status !== "recording" && r.segment !== true;
  if (notifyDone) r.archiveNotified = true;
  if (notifyFailed) r.archiveNotified = false;
  try { saveRecordings(); } catch (error) {
    for (const key of Object.keys(r)) delete r[key];
    Object.assign(r, previous);
    throw error;
  }
  sse.broadcast("recording-updated", { id, updates });
  // DDTalks starts as pending → starting → recording; the starting→recording
  // edge is where the capture actually begins, so it counts as 开始录制.
  if (notifyDone) {
    notify.event("recording_done", { id: r.id, title: r.title, memberName: r.memberName, duration: r.duration, size: r.fileSize || r.size });
  } else if (notifyFailed) {
    notify.event("recording_failed", { id: r.id, title: r.title, memberName: r.memberName, error: r.error || r.archiveError || "" });
  } else if (notifyStarted) {
    notify.event("recording_started", { id: r.id, title: r.title, memberName: r.memberName, liveId: r.liveId, source: r.source });
  }
  return r;
}

function getRecordings(filters = {}) {
  let list = [...recordings];
  if (!filters.includeDeleted && filters.status !== "deleted") list = list.filter(r => r.status !== "deleted");
  if (!filters.includeMerged && filters.status !== "merged") list = list.filter(r => r.status !== "merged");
  if (filters.status) list = list.filter(r => r.status === filters.status);
  if (filters.source) list = list.filter(r => r.source === filters.source);
  if (filters.limit) list = list.slice(0, filters.limit);
  return list;
}

function getRecording(id) {
  return recordings.find(r => r.id === id) || null;
}

// --- Upload Queue ---
function enqueueUpload(item) {
  const queued = {
    id: `up_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: "queued",
    addedAt: new Date().toISOString(),
    retries: 0,
    ...item,
  };
  uploadQueue.push(queued);
  saveQueue();
  sse.broadcast("upload-queued", queued);
  return queued;
}

function dequeueUpload(id) {
  const idx = uploadQueue.findIndex(x => x.id === id);
  if (idx === -1) return null;
  const [removed] = uploadQueue.splice(idx, 1);
  saveQueue();
  return removed;
}

function updateQueueItem(id, updates) {
  const item = uploadQueue.find(x => x.id === id);
  if (!item) return null;
  const previousStatus = item.status;
  Object.assign(item, updates);
  saveQueue();
  sse.broadcast("upload-updated", { id, updates });
  // Upload lifecycle notifications: a queue item reaching done/failed reports
  // the outcome once, keyed on the recording it belongs to.
  if (item.status !== previousStatus && item.status === "done") {
    notify.event("upload_done", { id, recordingId: item.recordingId, title: item.title, mode: item.mode, bvid: item.bvid });
  } else if (item.status !== previousStatus && item.status === "failed") {
    notify.event("upload_failed", { id, recordingId: item.recordingId, title: item.title, error: item.error });
  }
  return item;
}

function getQueue() { return [...uploadQueue]; }
function getQueueItem(id) { return uploadQueue.find(x => x.id === id) || null; }
function isUploadRunning() { return uploadRunning; }
function setUploadRunning(v) { uploadRunning = v; }

// --- Templates ---
function getTemplates() {
  return store.load("templates", []);
}

function saveTemplates(templates) {
  store.save("templates", templates);
  sse.broadcast("templates-updated", templates);
}

// Initialize
loadState();

module.exports = {
  addRecording, updateRecording, getRecordings, getRecording,
  enqueueUpload, dequeueUpload, updateQueueItem, getQueue, getQueueItem,
  isUploadRunning, setUploadRunning,
  getTemplates, saveTemplates,
  loadState, saveRecordings, saveQueue,
};
