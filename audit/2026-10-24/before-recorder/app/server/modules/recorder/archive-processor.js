"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const manager = require("./manager");
const recorder = require("../pocket48/recorder");
const uploadQueue = require("../bilibili/queue");

const MERGE_WINDOW_MS = Math.max(30_000, Number(process.env.RECORDING_MERGE_WINDOW_MS) || 5 * 60 * 1000);
// Automatic reconnects can spend several minutes waiting for a fresh stream
// URL. Extend only an explicitly linked auto segment; ordinary/manual recordings
// retain the conservative five-minute merge window.
const AUTO_RECONNECT_MERGE_WINDOW_MS = Math.max(
  MERGE_WINDOW_MS,
  Number(process.env.AUTO_RECONNECT_MERGE_WINDOW_MS) || 15 * 60 * 1000,
);
const timers = new Map();
const processing = new Map();
let serial = Promise.resolve();
let unsubscribe = null;

function cleanTopic(value) {
  return String(value || "直播").replace(/\s+/g, " ").trim() || "直播";
}

function topicOf(item) {
  if (item?.liveTitle) return cleanTopic(item.liveTitle);
  const title = cleanTopic(item?.title);
  const prefix = `${localDate(item?.startedAt || item?.createdAt)}-${String(item?.memberName || "Pocket48").trim() || "Pocket48"}-`;
  return title.startsWith(prefix) ? cleanTopic(title.slice(prefix.length)) : title;
}

function groupKey(item) {
  const member = String(item?.memberId || item?.autoMonitorId || item?.memberName || "unknown").trim().toLowerCase();
  return `${member}\u0000${topicOf(item).toLowerCase()}`;
}

function localDate(value, timeZone = process.env.RECORDING_TIME_ZONE || "Asia/Shanghai") {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function archiveTitle(item) {
  return `${localDate(item?.startedAt || item?.createdAt)}-${String(item?.memberName || "Pocket48").trim() || "Pocket48"}-${topicOf(item)}`;
}

// The session a recording belongs to is its own id when it owns the session, and
// its sessionId when it is a later segment of one. Resolving both sides this way
// makes an owner and its segments mutually compatible.
function sessionOf(item) {
  if (!item) return null;
  const owner = item.sessionId || item.id;
  return owner ? String(owner) : null;
}

function sameSession(left, right) {
  if (!left || !right) return false;
  if (!left.sessionId && !right.sessionId) return false;
  return sessionOf(left) !== null && sessionOf(left) === sessionOf(right);
}

function compatible(left, right) {
  // A segment attached by the manager to an existing session already proves the
  // two share one archive, even across a restart that lost the reconnect chain.
  if (sameSession(left, right)) return true;
  return groupKey(left) === groupKey(right) && (!left.liveId || !right.liveId || String(left.liveId) === String(right.liveId));
}

function isAutoReconnectPair(left, right) {
  // The manager links a later start to its session owner explicitly; trust that
  // link even when a restart dropped the reconnect chain.
  if (sameSession(left, right) && left?.autoMonitorId) return true;
  return Boolean(left?.autoMonitorId && right?.autoMonitorId && right?.reconnectOf
    && String(right.reconnectOf) === String(left.id)
    && left.liveId && right.liveId && String(left.liveId) === String(right.liveId));
}
function time(value, fallback = 0) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitSessions(items, mergeWindowMs = MERGE_WINDOW_MS) {
  const sorted = [...items].sort((a, b) => time(a.startedAt || a.createdAt) - time(b.startedAt || b.createdAt));
  const sessions = [];
  for (const item of sorted) {
    const current = sessions.at(-1);
    if (!current) {
      sessions.push([item]);
      continue;
    }
    const previous = current.at(-1);
    const gap = time(item.startedAt || item.createdAt) - time(previous.endedAt || previous.recordedAt || previous.startedAt || previous.createdAt);
    // A session link is authoritative: the recorder already declared these two
    // one live, so the merge window must not split them apart again.
    const linked = sameSession(previous, item);
    const window = linked || isAutoReconnectPair(previous, item) ? AUTO_RECONNECT_MERGE_WINDOW_MS : mergeWindowMs;
    if (compatible(previous, item) && (linked || gap <= window)) current.push(item);
    else sessions.push([item]);
  }
  return sessions;
}

function safeOutputPath(first, sourcePaths) {
  const dir = recorder._internals.recordingsDir();
  const base = recorder._internals.safeName(archiveTitle(first));
  let candidate = path.join(dir, `${base}.mp4`);
  let suffix = 2;
  const sources = new Set(sourcePaths.map((item) => path.resolve(item)));
  while (fs.existsSync(candidate) && !sources.has(path.resolve(candidate))) {
    candidate = path.join(dir, `${base}-${suffix}.mp4`);
    suffix += 1;
  }
  return candidate;
}

function concatLine(filePath) {
  return `file '${path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function resolveSource(filePath) {
  if (!filePath) throw new Error("Recording file not found");
  const root = fs.realpathSync(recorder._internals.recordingsDir());
  const candidate = fs.realpathSync(filePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.lstatSync(filePath).isFile()) throw new Error("Recording file is outside the recordings directory or not a regular file");
  return candidate;
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        if (code !== 0) throw new Error("媒体探测失败");
        const info = JSON.parse(output);
        if (!info.streams?.some((s) => s.codec_type === "video") || !(Number(info.format?.duration) > 0)) {
          throw new Error("录像没有可用的视频或时长");
        }
        resolve(info);
      } catch (error) { reject(error); }
    });
  });
}

function streamSignature(info) {
  return JSON.stringify(info.streams.map((s) => [s.codec_type, s.codec_name, s.width, s.height, s.pix_fmt,
    s.sample_rate, s.channels, s.channel_layout, s.time_base, s.extradata_size]));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-5000); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function makeMp4(sourcePaths, outputPath) {
  const temporary = outputPath.replace(/\.mp4$/i, ".processing.mp4");
  const concatPath = `${outputPath}.concat.txt`;
  const normalized = [];
  try {
    const infos = [];
    for (const source of sourcePaths) infos.push(await probe(source));
    const expectedDuration = infos.reduce((sum, info) => sum + Number(info.format.duration), 0);
    async function validate() {
      const info = await probe(temporary);
      if (Math.abs(Number(info.format.duration) - expectedDuration) > Math.max(3, expectedDuration * 0.03)) {
        throw new Error("MP4 时长与原始片段不符");
      }
      // Verify the entire video/audio, not just the MP4 header.
      await runFfmpeg(["-hide_banner", "-loglevel", "error", "-xerror", "-threads", "2", "-i", temporary,
        "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
    }
    if (sourcePaths.length > 1) fs.writeFileSync(concatPath, `${sourcePaths.map(concatLine).join("\n")}\n`, "utf8");
    const input = sourcePaths.length > 1
      ? ["-f", "concat", "-safe", "0", "-i", concatPath]
      : ["-i", sourcePaths[0]];
    const common = ["-hide_banner", "-loglevel", "warning", "-y", ...input, "-map", "0:v?", "-map", "0:a?", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero"];
    try {
      if (infos.some((info) => streamSignature(info) !== streamSignature(infos[0]))) throw new Error("片段参数不同，需要统一画面和音轨");
      if (infos.some((info) => info.streams.some((s) => s.codec_type === "video" && s.codec_name !== "h264"))) throw new Error("需要 H264 视频");
      await runFfmpeg([...common, "-c", "copy", temporary]);
      await validate();
    } catch (_copyError) {
      try { fs.unlinkSync(temporary); } catch {}
      const video = infos[0].streams.find((s) => s.codec_type === "video");
      const width = Math.max(2, Math.floor(video.width / 2) * 2);
      const height = Math.max(2, Math.floor(video.height / 2) * 2);
      for (let i = 0; i < sourcePaths.length; i += 1) {
        const file = `${outputPath}.segment-${i}.mp4`;
        normalized.push(file);
        const audio = infos[i].streams.some((s) => s.codec_type === "audio");
        await runFfmpeg(["-hide_banner", "-loglevel", "warning", "-y", "-threads", "2", "-i", sourcePaths[i],
          ...(!audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : []),
          "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0", "-t", String(infos[i].format.duration),
          "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,
          "-af", "aresample=async=1:first_pts=0,apad", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", "-video_track_timescale", "90000", file]);
      }
      fs.writeFileSync(concatPath, `${normalized.map(concatLine).join("\n")}\n`, "utf8");
      await runFfmpeg(["-hide_banner", "-loglevel", "warning", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", temporary]);
      await validate();
    }
    const size = fs.statSync(temporary).size;
    if (size <= 0) throw new Error("生成的 MP4 文件为空");
    if (require("../backup115/leases").lockedPath(outputPath) || require("../backup115/leases").lockedPath(temporary)) throw Object.assign(new Error("归档文件正在备份到115，请等待或取消备份后再替换"), { statusCode: 409 });
    fs.renameSync(temporary, outputPath);
    return size;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
    try { fs.unlinkSync(concatPath); } catch {}
    for (const file of normalized) { try { fs.unlinkSync(file); } catch {} }
  }
}

function candidatesFor(seed) {
  return manager.getRecordings({ includeMerged: true })
    .filter((item) => item.source !== "clip")
    .filter((item) => !item.manualStop)
    .filter((item) => ["waiting_merge", "processing", "archive_failed", "done"].includes(item.status))
    .filter((item) => !item.draftId && item.uploadStatus !== "done")
    .filter((item) => item.filePath && fs.existsSync(item.filePath))
    .filter((item) => compatible(seed, item));
}

function sessionFor(seed) {
  return splitSessions(candidatesFor(seed)).find((session) => session.some((item) => item.id === seed.id)) || [seed];
}

function matchingActive(session) {
  const last = session.at(-1);
  const ended = time(last.endedAt || last.recordedAt, Date.now());
  return recorder.listActive().some((item) => compatible(last, item) && time(item.startedAt, Infinity) - ended <= MERGE_WINDOW_MS);
}

function readyAt(session) {
  const last = session.at(-1);
  const window = last?.autoMonitorId && last?.reconnectOf && last?.reconnectable
    ? AUTO_RECONNECT_MERGE_WINDOW_MS : MERGE_WINDOW_MS;
  return time(last?.endedAt || last?.recordedAt, Date.now()) + window;
}

function schedule(item, delay) {
  if (!item?.id || item.status === "failed") return;
  const existing = timers.get(item.id);
  if (existing) clearTimeout(existing);
  const wait = item.manualStop ? 0 : delay === undefined ? Math.max(0, readyAt([item]) - Date.now()) : Math.max(0, delay);
  const timer = setTimeout(() => {
    timers.delete(item.id);
    void processRecording(item.id).catch((error) => console.error("[archive-processor]", error.message));
  }, wait);
  timer.unref?.();
  timers.set(item.id, timer);
}

function processRecording(id, options = {}) {
  if (processing.has(id)) return processing.get(id);
  const job = serial.then(() => processSerial(id, options));
  processing.set(id, job);
  serial = job.catch(() => {});
  void job.finally(() => processing.delete(id)).catch(() => {});
  return job;
}

async function processSerial(id, { immediate = false, autoEnqueue = true, merge = true } = {}) {
  const seed = manager.getRecording(id);
  if (!seed) throw new Error("Recording not found");
  if (seed.manualStop) { immediate = true; merge = false; }
  if (seed.status === "merged" && seed.mergedInto) return processSerial(seed.mergedInto, { immediate, autoEnqueue, merge });
  if (!["done", "waiting_merge", "processing", "archive_failed"].includes(seed.status)) {
    throw new Error("该录像尚未结束或已删除，不能归档");
  }
  resolveSource(seed.filePath);
  if (seed.source === "clip" && seed.status === "done") return seed;
  if (seed.status === "done" && path.extname(seed.filePath || "").toLowerCase() === ".mp4") {
    const title = archiveTitle(seed);
    const completed = manager.updateRecording(seed.id, {
      title,
      liveTitle: topicOf(seed),
      fileName: seed.archiveOrigin === "official_replay" ? seed.fileName : path.basename(seed.filePath),
      container: "mp4",
    });
    return finishReplay(completed, autoEnqueue);
  }
  const session = merge ? sessionFor(seed) : [seed];
  const remaining = readyAt(session) - Date.now();
  if (immediate && !seed.manualStop && matchingActive(session)) throw new Error("同场直播仍在录制，请结束后再整理");
  if (!immediate && (remaining > 0 || matchingActive(session) || recorder.listActive().length > 0)) {
    for (const item of session) manager.updateRecording(item.id, { status: "waiting_merge", archiveError: null });
    schedule(seed, Math.max(15_000, remaining));
    return manager.getRecording(seed.id);
  }

  const sourcePaths = session.map((item) => resolveSource(item.filePath));
  const first = session[0];
  for (const item of session) manager.updateRecording(item.id, { status: "processing", archiveError: null });
  try {
    const outputPath = safeOutputPath(first, sourcePaths);
    const size = await makeMp4(sourcePaths, outputPath);
    const title = archiveTitle(first);
    const endedAt = session.at(-1).endedAt || session.at(-1).recordedAt;
    const sourceRecordingIds = session.map((item) => item.id);
    manager.updateRecording(first.id, {
      status: "done",
      title,
      liveTitle: topicOf(first),
      filePath: outputPath,
      fileName: path.basename(outputPath),
      container: "mp4",
      size,
      fileSize: size,
      endedAt,
      recordedAt: endedAt,
      segmentCount: session.length,
      autoUpload: session.some((item) => item.autoUpload),
      autoMonitorId: first.autoMonitorId || session.find((item) => item.autoMonitorId)?.autoMonitorId || null,
      sourceRecordingIds,
      sourceFiles: sourcePaths,
      archivedAt: new Date().toISOString(),
      archiveError: null,
    });
    for (const item of session.slice(1)) {
      manager.updateRecording(item.id, { status: "merged", mergedInto: first.id, filePath: null, size: 0, fileSize: 0 });
    }
    // Replay acquisition may already be running from the finalized event.
    await finishReplay(manager.getRecording(first.id), false);
    // Keep originals recoverable. Archiving must never destroy the only copy.
    try { await require("./covers").generate(manager.getRecording(first.id)); }
    catch (error) { manager.updateRecording(first.id, { coverError: error.message }); }
    const completed = manager.getRecording(first.id);
    if (autoEnqueue && !completed.draftId && completed.uploadStatus !== "done" && session.some((item) => item.autoUpload)) {
      try { uploadQueue.enqueueRecording(first.id, { mode: "draft", autoUpload: true, title }); }
      catch (error) { console.error("[archive-processor] automatic draft enqueue failed:", error.message); }
    }
    return completed;
  } catch (error) {
    for (const item of session) manager.updateRecording(item.id, { status: "archive_failed", archiveError: error.message });
    throw error;
  }
}

async function finishReplay(recording, autoEnqueue) {
  const recovery = require("./replay-recovery");
  if (recovery._internals.needsQualityGate(recording) && (recording.autoMonitorId || recording.autoUpload || recording.replayRecovery)) {
    recording = await recovery.recover(recording, { automatic: recording.replayRecovery?.automatic !== false });
    if (recovery.holdsUpload(recording)) {
      schedule(recording, Math.max(15000, Date.parse(recording.replayRecovery?.nextAttemptAt || "") - Date.now() || 15000));
      return recording;
    }
    if (autoEnqueue && recording.autoUpload && !recording.draftId && recording.uploadStatus !== "done"
      && recovery.uploadReadiness(recording, { autoUpload: true }).ready) {
      try {
        if (!recording.coverFile) await require("./covers").generate(recording);
        uploadQueue.enqueueRecording(recording.id, { mode: "draft", autoUpload: true, title: recording.title });
      } catch (error) { console.error("[archive-processor] automatic draft enqueue failed:", error.message); }
    }
  }
  return recording;
}

async function prepareForUpload(id) {
  if (manager.getRecording(id)?.mediaType === 'audio') throw new Error('音频归档请直接下载；B站草稿需要视频文件');
  return processRecording(id, { immediate: true, autoEnqueue: false });
}

function start() {
  if (!unsubscribe) unsubscribe = recorder.onFinalized((item) => {
    require("./replay-recovery").prefetch(item);
    if (item?.status === "waiting_merge" || (item?.manualStop && item.status === "processing")) schedule(item);
  });
  for (const item of manager.getRecordings({ includeMerged: true })) {
    if (item.source === "pocket48" && item.memberName && item.title && !["recording", "deleted", "merged"].includes(item.status)) {
      const title = archiveTitle(item);
      if (item.title !== title || !item.liveTitle) manager.updateRecording(item.id, { title, liveTitle: topicOf(item) });
    }
    if (["waiting_merge", "processing"].includes(item.status)) schedule(item, 1_000);
    if (item.status === "done" && (require("./replay-recovery").holdsUpload(item)
      || (item.autoUpload && !item.draftId && item.uploadStatus !== "done"
        && require("./replay-recovery").uploadReadiness(item, { autoUpload: true }).code === "REPLAY_RECOVERY_REQUIRED"))) schedule(item, 1000);
  }
}

function stop() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

module.exports = {
  start,
  stop,
  schedule,
  processRecording,
  prepareForUpload,
  busy: id => processing.has(id),
  _internals: { MERGE_WINDOW_MS, AUTO_RECONNECT_MERGE_WINDOW_MS, cleanTopic, topicOf, groupKey, localDate, archiveTitle, compatible, isAutoReconnectPair, splitSessions, concatLine, makeMp4, resolveSource, probe, streamSignature },
};
