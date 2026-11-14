"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const manager = require("./manager");
const media = require("./archive-processor")._internals;
const ACTIVE = ["clip_queued", "clip_processing"];
let running = false;
let timer;
let child;
let stopped = false;

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function range(start, end, duration = Infinity) {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end - start < 1 || end > duration + 0.05 || end - start > 7200) {
    throw fail("请选择有效片段：至少 1 秒、最长 2 小时，且不能超出录像时长");
  }
  return { start, end };
}
function busy(id) {
  return manager.getRecordings().some(r => ACTIVE.includes(r.status) && (r.id === id || r.parentRecordingId === id));
}
function ranges(options, duration = Infinity) {
  const input = options.segments === undefined ? [{ start: options.start, end: options.end }] : options.segments;
  if (!Array.isArray(input) || !input.length || input.length > 30) throw fail("请选择 1 至 30 个保留片段");
  const result = input.map(s => range(s?.start, s?.end, duration)).sort((a, b) => a.start - b.start);
  if (result.some((s, i) => i > 0 && s.start < result[i - 1].end)) throw fail("保留片段不能重叠");
  if (result.reduce((sum, s) => sum + s.end - s.start, 0) > 7200) throw fail("成片总时长不能超过 2 小时");
  return result;
}
function list(id) { return manager.getRecordings().filter(r => r.source === "clip" && r.parentRecordingId === id); }
function enqueue(id, options = {}) {
  if (require('./replay-recovery').busy(id)) throw fail('请等待官方回放下载与对比完成',409);
  const parent = manager.getRecording(id);
  if (!parent || parent.status === "deleted") throw fail("录像不存在", 404);
  if (parent.status !== "done") throw fail("请等待录像归档完成", 409);
  if (parent.mediaType === 'audio') throw fail('音频归档暂不支持视频剪辑');
  media.resolveSource(parent.filePath);
  const segments = ranges(options);
  const start = segments[0].start, end = segments.at(-1).end;
  const title = String(options.title || `${parent.title || "录像"} · 片段`).trim().slice(0, 160);
  if (!title) throw fail("请填写片段标题");
  // Reserve synchronously, before any probe or transcode, to avoid duplicate clicks.
  const existing = list(id).find(r => ACTIVE.includes(r.status) && JSON.stringify(r.segments || [{ start: r.clipStart, end: r.clipEnd }]) === JSON.stringify(segments));
  if (existing) return existing;
  if (manager.getRecordings().filter(r => ACTIVE.includes(r.status)).length >= 20) throw fail("剪辑队列已满，请稍后再试", 429);
  const item = manager.addRecording({ source: "clip", parentRecordingId: id, memberName: parent.memberName,
    memberId: parent.memberId, title, clipStart: start, clipEnd: end, segments, duration: segments.reduce((sum, s) => sum + s.end - s.start, 0),
    status: "clip_queued", clipProgress: 0, container: "mp4" });
  setImmediate(() => void pump());
  return item;
}
function retry(id) {
  const item = manager.getRecording(id);
  if (!item || item.source !== "clip" || item.status !== "clip_failed") throw fail("仅失败的剪辑可以重试", 409);
  const parent = manager.getRecording(item.parentRecordingId);
  if (!parent || parent.status !== "done") throw fail("原始录像已不可用", 409);
  media.resolveSource(parent.filePath);
  if (manager.getRecordings().filter(r => ACTIVE.includes(r.status)).length >= 20) throw fail("剪辑队列已满，请稍后再试", 429);
  manager.updateRecording(id, { status: "clip_queued", clipError: null, clipProgress: 0 });
  setImmediate(() => void pump());
  return item;
}
function transcode(input, output, item, hasAudio) {
  const segments = item.segments || [{ start: item.clipStart, end: item.clipEnd }];
  const offset = segments[0].start;
  const filters = segments.flatMap((s, i) => [
    `[0:v:0]trim=start=${s.start - offset}:end=${s.end - offset},setpts=PTS-STARTPTS,pad=ceil(iw/2)*2:ceil(ih/2)*2[v${i}]`,
    ...(hasAudio ? [`[0:a:0]atrim=start=${s.start - offset}:end=${s.end - offset},asetpts=PTS-STARTPTS[a${i}]`] : [])
  ]);
  filters.push(segments.map((_, i) => `[v${i}]${hasAudio ? `[a${i}]` : ""}`).join("") + `concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`);
  return new Promise((resolve, reject) => {
    child = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", String(offset), "-t", String(segments.at(-1).end - offset), "-i", input, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[v]", ...(hasAudio ? ["-map", "[a]"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart",
      "-progress", "pipe:1", output], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const processHandle = child;
    let last = 0;
    let buffer = "";
    const timeout = setTimeout(() => processHandle.kill(), 6 * 60 * 60 * 1000);
    processHandle.stderr.resume();
    processHandle.stdout.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match) continue;
        const progress = Math.min(99, Math.floor(Number(match[1]) / 1e6 / item.duration * 100));
        if (progress >= last + 5) { last = progress; manager.updateRecording(item.id, { clipProgress: progress }); }
      }
    });
    processHandle.once("error", error => { clearTimeout(timeout); reject(error); });
    processHandle.once("close", code => { clearTimeout(timeout); child = null;
      code === 0 ? resolve() : reject(fail(stopped ? "服务停止，剪辑可重试" : "片段生成失败，请检查磁盘空间和媒体文件后重试")); });
  });
}
async function pump() {
  if (running || stopped) return;
  // Recording and archive work take priority; only one bounded transcode runs at a time.
  if (manager.getRecordings().some(r => ["recording", "processing", "waiting_merge"].includes(r.status))) return;
  const item = manager.getRecordings().reverse().find(r => r.status === "clip_queued");
  if (!item) return;
  running = true;
  let temporary;
  try {
    manager.updateRecording(item.id, { status: "clip_processing", clipError: null });
    const parent = manager.getRecording(item.parentRecordingId);
    if (parent?.status !== "done") throw fail("原始录像已不可用");
    const input = media.resolveSource(parent.filePath);
    const info = await media.probe(input);
    if (stopped) throw fail("服务停止，剪辑可重试");
    const segments = ranges(item.segments ? item : { start: item.clipStart, end: item.clipEnd }, Number(info.format.duration));
    manager.updateRecording(item.id, { segments, duration: segments.reduce((sum, s) => sum + s.end - s.start, 0) });
    const output = path.join(path.dirname(input), `${item.id}.mp4`);
    temporary = path.join(path.dirname(input), `${item.id}.partial.mp4`);
    manager.updateRecording(item.id, { filePath: temporary });
    await transcode(input, temporary, item, info.streams.some(s => s.codec_type === "audio"));
    const result = await media.probe(temporary);
    if (Math.abs(Number(result.format.duration) - item.duration) > 0.5) throw fail("生成片段时长不符，请重试");
    if (require("../backup115/leases").lockedPath(output) || require("../backup115/leases").lockedPath(temporary)) throw fail("片段正在备份到115，请等待或取消备份后再替换", 409);
    fs.renameSync(temporary, output);
    manager.updateRecording(item.id, { status: "done", filePath: output, fileName: path.basename(output),
      size: fs.statSync(output).size, fileSize: fs.statSync(output).size, duration: Number(result.format.duration),
      clipProgress: 100, archivedAt: new Date().toISOString() });
  } catch (error) {
    if (temporary && fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch {} }
    manager.updateRecording(item.id, { status: "clip_failed", filePath: temporary && fs.existsSync(temporary) ? temporary : item.filePath && fs.existsSync(item.filePath) ? item.filePath : null,
      clipError: error.statusCode ? error.message : "媒体处理失败，请检查文件和 FFmpeg 后重试" });
  } finally { running = false; if (!stopped) setImmediate(() => void pump()); }
}
function start() {
  stopped = false;
  for (const item of manager.getRecordings()) {
    if (item.status === "clip_processing") manager.updateRecording(item.id, { status: "clip_failed", clipError: "服务重启中断了剪辑，请重试" });
  }
  if (!timer) { timer = setInterval(() => void pump(), 5000); timer.unref(); }
  void pump();
}
function stop() { stopped = true; clearInterval(timer); timer = null; child?.kill(); }
module.exports = { enqueue, retry, list, busy, start, stop, _internals: { range, ranges, pump, isRunning: () => running } };
