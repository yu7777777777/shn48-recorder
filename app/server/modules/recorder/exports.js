"use strict";

// Real transcoding exports ("真实转码导出落地"): turn the 1.28.0 parameter-level
// profiles (landscape / portrait / audio-only) into actual ffmpeg encodes of a
// finished archive, with optional subtitle burn-in. Modeled on recorder/clips:
// one bounded job at a time, deferred while recording/archive work runs,
// durable job list, progress via `ffmpeg -progress`.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const store = require("../../lib/store");
const manager = require("./manager");
const media = require("./archive-processor")._internals;
const exportProfiles = require("../analysis/export-profiles");

const JOBS_KEY = "export_jobs";
const JOBS_LIMIT = 50;
const LANGUAGES = new Set(["original", "en", "ja", "bilingual", "ja-bilingual"]);

let jobs = store.load(JOBS_KEY, []);
if (!Array.isArray(jobs)) jobs = [];
let running = false;
let stopped = false;
let timer;
let child;

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const persist = () => {
  if (jobs.length > JOBS_LIMIT) jobs = jobs.slice(0, JOBS_LIMIT);
  store.save(JOBS_KEY, jobs);
};
const dto = job => ({ ...job, filePath: undefined });

function recordingTitle(recordingId) {
  const rec = manager.getRecording(recordingId);
  return rec ? String(rec.title || rec.memberName || "录像") : "录像";
}

// ffmpeg filter paths need quoting plus escaping of the filter's special
// characters; Windows drive letters (C:\…) are the common colon case.
function filterEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function videoFilterChain(profile, burn) {
  const geometry = profile.profile === "portrait"
    // Fill 1080x1920: scale up so both dimensions cover the frame, then centre
    // crop — the vertical video target expects no letterbox bars.
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    // Fit 1920x1080: scale down inside the frame and pad the remainder black.
    : "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
  const chain = [geometry, "format=yuv420p"];
  if (burn?.filter) chain.push(burn.filter);
  return chain.join(",");
}

function buildArgs({ input, output, profile, burn }) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input];
  if (profile.profile === "audio") {
    args.push("-vn", "-c:a", "aac", "-b:a", profile.audioBitrate, "-movflags", "+faststart");
  } else {
    args.push("-filter_complex_threads", "1", "-filter_complex",
      `[0:v:0]${videoFilterChain(profile, burn)}[v]`, "-map", "[v]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-threads", Number(process.env.EXPORT_FFMPEG_THREADS) || 1, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", profile.audioBitrate, "-movflags", "+faststart");
  }
  args.push("-progress", "pipe:1", output);
  return args;
}

async function probeDuration(input) {
  // archive-processor's probe() insists on a video stream; audio-only archives
  // (room voice m4a, audio profile) need the bare format duration.
  const { stdout } = await media.spawnWithTimeout(
    process.env.FFPROBE_BIN || "ffprobe",
    ["-v", "error", "-show_format", "-of", "json", input],
    { timeoutMs: 60000, timeoutLabel: "媒体探测", collectStdout: true, exitError: () => new Error("媒体探测失败") },
  );
  return Number(JSON.parse(stdout).format?.duration) || 0;
}

function run(job, input, output, burn) {
  return new Promise((resolve, reject) => {
    child = spawn(process.env.FFMPEG_BIN || "ffmpeg", buildArgs({ input, output, profile: exportProfiles.resolve(job.profile), burn }), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = child;
    let last = 0;
    let buffer = "";
    const duration = job.duration || 0;
    const timeout = setTimeout(() => handle.kill("SIGKILL"), 12 * 60 * 60 * 1000);
    handle.stderr.resume();
    handle.stdout.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match) continue;
        const progress = duration > 0 ? Math.min(99, Math.floor(Number(match[1]) / 1e6 / duration * 100)) : 0;
        if (progress >= last + 5) {
          last = progress;
          update(job.id, { progress });
        }
      }
    });
    handle.once("error", error => { clearTimeout(timeout); child = null; reject(error); });
    handle.once("close", code => {
      clearTimeout(timeout);
      child = null;
      if (code === 0) resolve();
      else reject(fail(stopped ? "服务停止，导出可重试" : "转码失败，请检查磁盘空间与媒体文件后重试", 500));
    });
  });
}

function update(id, patch) {
  const job = jobs.find(item => item.id === id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  persist();
  return job;
}

function enqueue({ recordingId, profile, burnSubtitle, language }) {
  if (stopped) throw fail("服务停止中，请稍后重试", 409);
  const resolved = exportProfiles.resolve(profile);
  const recording = manager.getRecording(String(recordingId || ""));
  if (!recording || recording.status === "deleted") throw fail("归档不存在", 404);
  if (recording.status !== "done") throw fail("请等待录像归档完成", 409);
  if (recording.mediaType === "audio" && resolved.profile !== "audio") throw fail("音频归档只能导出仅音频档位", 400);
  const wantsBurn = burnSubtitle === true && resolved.profile !== "audio";
  const lang = LANGUAGES.has(language) ? language : "original";
  if (wantsBurn) {
    // Burning needs an actual subtitle track; fail before queueing instead of
    // after a long encode.
    const analysis = store.load(`analysis_${recording.id}`, null);
    if (!Array.isArray(analysis?.segments) || !analysis.segments.length) throw fail("这条归档还没有字幕，无法烧录字幕", 409);
  }
  const source = media.resolveSource(recording.filePath);
  const extension = resolved.container === "m4a" ? "m4a" : "mp4";
  // Non-burn jobs store language:null; the dedupe key must compare the stored
  // value, not the requested one, or identical jobs duplicate.
  const effectiveLanguage = wantsBurn ? lang : null;
  const duplicate = jobs.find(job => job.recordingId === recording.id && job.profile === resolved.profile
    && job.burnSubtitle === wantsBurn && job.language === effectiveLanguage && ["queued", "running"].includes(job.status));
  if (duplicate) return dto(duplicate);
  if (jobs.filter(job => ["queued", "running"].includes(job.status)).length >= 5) throw fail("导出队列已满，请等待现有任务完成", 429);
  const job = {
    id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    recordingId: recording.id,
    profile: resolved.profile,
    burnSubtitle: wantsBurn,
    language: effectiveLanguage,
    status: "queued",
    progress: 0,
    error: null,
    duration: Number(recording.duration) || 0,
    filePath: null,
    fileName: `${recording.id}.${resolved.profile}${wantsBurn ? ".burned" : ""}.${extension}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.unshift(job);
  persist();
  setImmediate(() => void pump());
  return dto(job);
}

function burnFilter(job, source) {
  if (!job.burnSubtitle) return null;
  const analysis = store.load(`analysis_${job.recordingId}`, null);
  const text = require("../analysis/service").subtitle(analysis.segments, job.language || "original");
  const srtPath = path.join(path.dirname(source), `${job.id}.burn.srt`);
  fs.writeFileSync(srtPath, text, "utf8");
  return { filter: `subtitles='${filterEscape(srtPath)}'`, cleanup: () => { try { fs.unlinkSync(srtPath); } catch {} } };
}

async function pump() {
  if (running || stopped) return;
  // Recording and archive work take priority, mirroring the clips queue.
  if (manager.getRecordings().some(row => ["recording", "processing", "waiting_merge"].includes(row.status))) return;
  const job = jobs.find(item => item.status === "queued");
  if (!job) return;
  running = true;
  let burn = null;
  try {
    update(job.id, { status: "running", progress: 0, error: null });
    const recording = manager.getRecording(job.recordingId);
    if (!recording || recording.status !== "done") throw fail("原始录像已不可用", 409);
    const input = media.resolveSource(recording.filePath);
    if (!job.duration) update(job.id, { duration: await probeDuration(input) });
    burn = burnFilter(job, input);
    const output = path.join(path.dirname(input), job.fileName);
    await run(job, input, output, burn);
    const stat = fs.statSync(output);
    update(job.id, { status: "done", progress: 100, filePath: output, size: stat.size, error: null, finishedAt: new Date().toISOString() });
    require("../notify").event("export_done", { recordingId: job.recordingId, title: recordingTitle(job.recordingId), profile: job.profile, size: stat.size });
  } catch (error) {
    if (burn?.cleanup) burn.cleanup();
    burn = null;
    update(job.id, { status: "failed", error: error.statusCode ? error.message : "媒体处理失败，请检查文件和 FFmpeg 后重试", finishedAt: new Date().toISOString() });
    require("../notify").event("export_failed", { recordingId: job.recordingId, title: recordingTitle(job.recordingId), profile: job.profile, error: error.statusCode ? error.message : "转码失败" });
  } finally {
    if (burn?.cleanup) burn.cleanup();
    running = false;
    if (!stopped) setImmediate(() => void pump());
  }
}

function retry(id) {
  const job = jobs.find(item => item.id === id);
  if (!job) throw fail("导出任务不存在", 404);
  if (job.status !== "failed") throw fail("仅失败的导出可以重试", 409);
  update(id, { status: "queued", progress: 0, error: null, finishedAt: null });
  setImmediate(() => void pump());
  return dto(job);
}

function remove(id, { deleteFile = false } = {}) {
  const job = jobs.find(item => item.id === id);
  if (!job) throw fail("导出任务不存在", 404);
  if (job.status === "running") throw fail("导出正在进行，请等待完成后再删除", 409);
  if (deleteFile && job.filePath) {
    try {
      const recordingsRoot = path.resolve(require("../pocket48/recorder")._internals.recordingsDir());
      const candidate = path.resolve(job.filePath);
      if (candidate.startsWith(recordingsRoot + path.sep) && fs.existsSync(candidate)) fs.unlinkSync(candidate);
    } catch { /* a file that is already gone or unreadable must not block the record removal */ }
  }
  jobs = jobs.filter(item => item.id !== id);
  persist();
  return { removed: true };
}

function list() {
  return jobs.map(job => ({ ...dto(job), title: recordingTitle(job.recordingId) }));
}

// Raw job for the download route: unlike list(), the local file path is needed.
function get(id) {
  return jobs.find(item => item.id === id) || null;
}

function start() {
  stopped = false;
  // A job that was mid-encode when the process died is not resumable; mark it
  // retryable exactly like the clips queue does after a restart.
  for (const job of jobs) {
    if (job.status === "running") update(job.id, { status: "failed", error: "服务重启中断了导出，请重试" });
  }
  if (!timer) { timer = setInterval(() => void pump(), 10000); timer.unref(); }
  void pump();
}

function stop() {
  stopped = true;
  clearInterval(timer);
  timer = null;
  child?.kill();
}

module.exports = { enqueue, retry, remove, list, get, start, stop, _internals: { buildArgs, videoFilterChain, filterEscape, dto } };
