"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const store = require("../../lib/store");
const manager = require("../recorder/manager");
const liveService = require("./live");
const { EventEmitter } = require("events");

const active = new Map();
const events = new EventEmitter();

function recordingsDir() {
  return process.env.RECORDINGS_DIR || path.join(store.dataDir, "recordings", "pocket48");
}

function durationEnv(name, fallback, min) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

const HEALTH_CHECK_MS = durationEnv("RECORDING_HEALTH_CHECK_MS", 30_000, 5_000);
const STALL_MS = durationEnv("RECORDING_STALL_MS", 90_000, HEALTH_CHECK_MS * 2);

function safeName(value) {
  return String(value || "live")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "live";
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function recordingTitle({ startedAt, memberName, liveTitle }) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.RECORDING_TIME_ZONE || "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(startedAt));
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}-${memberName}-${liveTitle || "直播"}`;
}

function publicActive(entry) {
  return {
    recordingId: entry.recordingId,
    liveId: entry.liveId,
    title: entry.title,
    memberId: entry.memberId,
    memberName: entry.memberName,
    startedAt: entry.startedAt,
  };
}

function listActive() {
  return [...active.values()].map(publicActive);
}

const PERSIST_RETRY_DELAY_MS = 1_000;

// Finalize runs inside child-process event listeners, so a throw here becomes an
// uncaughtException that kills the whole process and every concurrent recording.
// A failing atomicWrite (full disk, locked index) must therefore never surface:
// retry once, then keep the finalized state in memory so any later
// updateRecording persists it once the disk recovers. Returns null only when
// persistence failed; a persisted null recording (deleted mid-flight) is a
// successful result and keeps the original single "finalized" emission.
function persistFinalized(recordingId, updates) {
  try {
    return { recording: manager.updateRecording(recordingId, updates) };
  } catch (error) {
    console.error(`[recorder] persisting finalized state of recording ${recordingId} failed: ${error.message}; retrying in ${PERSIST_RETRY_DELAY_MS}ms`);
    setTimeout(() => {
      let recording = null;
      try {
        recording = manager.updateRecording(recordingId, updates);
      } catch (retryError) {
        console.error(`[recorder] persisting finalized state of recording ${recordingId} failed again: ${retryError.message}; keeping in-memory state`);
        recording = manager.getRecording(recordingId);
        if (recording) Object.assign(recording, updates);
      }
      try { events.emit("finalized", recording); }
      catch (error) { console.error(`[recorder] finalized listener for recording ${recordingId} failed: ${error.message}`); }
    }, PERSIST_RETRY_DELAY_MS).unref?.();
    return null;
  }
}

function finalize(entry, code, signal, processError) {
  if (entry.finalized) return manager.getRecording(entry.recordingId);
  entry.finalized = true;
  if (entry.healthTimer) { clearInterval(entry.healthTimer); entry.healthTimer = null; }
  active.delete(entry.recordingId);
  let size = 0;
  try { size = fs.statSync(entry.partialPath).size; } catch {}
  // A disconnect may exit nonzero with usable media; the archive probe decides.
  const usable = size > 0;
  let filePath = entry.partialPath;
  if (usable) {
    try {
      fs.renameSync(entry.partialPath, entry.finalPath);
      filePath = entry.finalPath;
    } catch (err) {
      processError = processError || err;
    }
  }
  const endedAt = new Date().toISOString();
  const updates = {
    status: usable && !processError ? (entry.manualStop ? "processing" : "waiting_merge") : "failed",
    manualStop: entry.manualStop === true,
    endedAt,
    recordedAt: endedAt,
    size,
    filePath,
    exitCode: code,
    signal: signal || null,
    error: processError ? processError.message : (entry.failureReason || (usable ? null : `ffmpeg exited with code ${code}`)),
    reconnectable: !entry.manualStop && !entry.stopRequested,
  };
  const persisted = persistFinalized(entry.recordingId, updates);
  // Consumers such as automatic upload subscribe here instead of racing ffmpeg.
  if (!persisted) return manager.getRecording(entry.recordingId);
  const recording = persisted.recording;
  try { events.emit("finalized", recording); }
  catch (error) { console.error(`[recorder] finalized listener for recording ${entry.recordingId} failed: ${error.message}`); }
  return recording ?? manager.getRecording(entry.recordingId);
}

// liveId -> Promise of the start() call that currently owns this session.
// Claiming before the first await closes the window where two concurrent
// callers both pass the active-map check during liveService.getLive().
const starting = new Map();

function sessionOwner(liveId) {
  const id = String(liveId);
  const entry = [...active.values()].find((item) => String(item.liveId) === id);
  if (entry) return { recordingId: entry.recordingId, started: false };
  const running = starting.get(id);
  return running ? { recordingId: null, started: false, pending: running } : null;
}

async function start(liveId, options = {}) {
  if (!liveId) throw new Error("liveId is required");
  const sessionId = String(liveId);
  const owner = sessionOwner(sessionId);
  if (owner) {
    if (owner.pending) return owner.pending;
    return publicActive([...active.values()].find((item) => String(item.liveId) === sessionId));
  }

  // Share the actual launch result (or error) with every concurrent caller.
  // A separate release-only promise would incorrectly resolve duplicates to null.
  const claim = launch(sessionId, options);
  starting.set(sessionId, claim);
  try {
    return await claim;
  } finally {
    starting.delete(sessionId);
  }
}

async function launch(liveId, options = {}) {
  const { live, streamUrl } = await liveService.getLive(liveId);
  if (!streamUrl) throw new Error("Live stream URL is unavailable");
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const memberName = live.member.name || "Pocket48";
  const startedAt = new Date().toISOString();
  const title = recordingTitle({ startedAt, memberName, liveTitle: live.title });
  const base = `${timestamp()}_${safeName(title)}_${safeName(live.liveId)}`;
  const finalPath = path.join(dir, `${base}.flv`);
  const partialPath = path.join(dir, `${base}.partial.flv`);
  const recording = manager.addRecording({
    source: "pocket48",
    liveId: live.liveId,
    title,
    liveTitle: live.title,
    memberId: live.member.id,
    memberName,
    liveCoverUrl: live.cover || "",
    memberAvatarUrl: live.member.avatar || "",
    startedAt,
    status: "recording",
    filePath: partialPath,
    claimKey: String(liveId),
    claimedAt: new Date().toISOString(),
    ...(options.autoMonitorId ? {
      autoMonitorId: String(options.autoMonitorId), autoUpload: true,
      ...(options.reconnectOf ? { reconnectOf: String(options.reconnectOf) } : {}),
    } : {}),
  });

  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-rw_timeout", "15000000",
    "-i", streamUrl,
    "-map", "0:v?", "-map", "0:a?", "-c", "copy",
    "-f", "flv", partialPath,
  ];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const entry = {
    recordingId: recording.id,
    liveId: live.liveId,
    title: live.title,
    memberId: live.member.id,
    memberName,
    startedAt,
    finalPath,
    partialPath,
    child,
    stderr: "",
    stopRequested: false,
    finalized: false,
    lastSize: 0,
    lastGrowthAt: Date.now(),
    failureReason: null,
    healthTimer: null,
  };
  active.set(recording.id, entry);
  entry.healthTimer = setInterval(() => {
    if (entry.finalized || entry.stopRequested) return;
    let size = 0;
    try { size = fs.statSync(entry.partialPath).size; } catch {}
    if (size > entry.lastSize) {
      entry.lastSize = size;
      entry.lastGrowthAt = Date.now();
      return;
    }
    if (Date.now() - entry.lastGrowthAt < STALL_MS) return;
    entry.failureReason = `ffmpeg output stalled for ${STALL_MS}ms`;
    try { entry.child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (!entry.finalized && !entry.stopRequested) {
        try { entry.child.kill("SIGKILL"); } catch {}
      }
    }, 3_000).unref?.();
  }, HEALTH_CHECK_MS);
  entry.healthTimer.unref?.();
  child.stderr.on("data", (chunk) => { entry.stderr = (entry.stderr + chunk.toString()).slice(-4000); });
  child.once("error", (err) => finalize(entry, null, null, err));
  child.once("close", (code, signal) => finalize(entry, code, signal, null));
  return publicActive(entry);
}

function stop(recordingId, { manual = false } = {}) {
  const entry = active.get(recordingId);
  if (!entry) throw new Error("Active recording not found");
  entry.stopRequested = true;
  entry.manualStop = manual === true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve(finalize(entry, code, signal, null));
    };
    entry.child.once("close", done);
    try { entry.child.stdin.write("q\n"); } catch { entry.child.kill("SIGTERM"); }
    const forceTimer = setTimeout(() => {
      try { entry.child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (!settled) {
          try { entry.child.kill("SIGKILL"); } catch {}
        }
      }, 3000).unref?.();
    }, 8000);
    forceTimer.unref?.();
  });
}

async function stopAll() {
  const ids = [...active.keys()];
  const results = await Promise.allSettled(ids.map((recordingId) => stop(recordingId)));
  return results.map((result, index) => ({
    recordingId: ids[index],
    success: result.status === "fulfilled",
    ...(result.status === "fulfilled" ? { recording: result.value } : { error: result.reason?.message || "Unable to stop recording" }),
  }));
}

module.exports = {
  start, stop, listActive, stopAll,
  onFinalized(listener) { events.on("finalized", listener); return () => events.off("finalized", listener); },
  _internals: { safeName, recordingsDir, finalize, recordingTitle, active, events },
};
