"use strict";

// Download every HLS resource first. FFmpeg only receives a local playlist;
// deletion upstream during validation cannot turn a partial download into success.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { spawn } = require("child_process");
const store = require("../../lib/store");
const proxy = require("../pocket48/replay-proxy")._internals;
const replay = require("../pocket48/replay");
const RESERVE = 1024 * 1024 * 1024;

function atomicJson(file, value) {
  store.atomicWrite(file, value);
}
function freeBytes(dir) {
  const stat = fs.statfsSync(dir, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}
function requireSpace(dir, additional = 0) {
  if (freeBytes(dir) < RESERVE + additional) throw new Error("磁盘空间不足，已保留原录像，请清理空间后重试");
}
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function run(bin, args, timeout = 2 * 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-200000); });
    child.stderr.resume(); // Never expose source URLs or resource tokens in errors.
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("回放视频处理或完整解码校验失败")); });
  });
}
async function probe(file) {
  const raw = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], 60000);
  const info = JSON.parse(raw);
  if (!info.streams?.some(s => s.codec_type === "video") || !(Number(info.format?.duration) > 0)) throw new Error("视频缺少有效画面或时长");
  return info;
}
function mediaPlan(text, baseUrl, scope) {
  if (!text.startsWith("#EXTM3U") || !text.includes("#EXT-X-ENDLIST")) throw new Error("官方回放尚未生成完整清单");
  if (/#EXT-X-(?:GAP|BYTERANGE)|BYTERANGE=/.test(text)) throw new Error("回放含缺失分片或暂不支持的分片格式");
  proxy.authorizeManifestResources(text, baseUrl, { scope });
  const resources = [];
  const known = new Map();
  let seconds = 0, segments = 0, awaitingSegment = false;
  function resource(raw) {
    const url = proxy.validateSourceUrl(new URL(raw, baseUrl), scope).href;
    if (!known.has(url)) {
      const parsed = new URL(url);
      const extension = /\.([a-z0-9]{1,8})$/i.exec(parsed.pathname)?.[1] || "bin";
      const name = `asset-${String(resources.length).padStart(5, "0")}.${extension}`;
      known.set(url, name); resources.push({ url, name });
    }
    return known.get(url);
  }
  const local = text.split(/\r?\n/).map(line => {
    line = line.trim();
    if (line.startsWith("#EXTINF:")) {
      if (awaitingSegment) throw new Error("回放分片清单不完整");
      const duration = Number(line.slice(8).split(",")[0]);
      if (!(duration > 0)) throw new Error("回放分片时长无效");
      seconds += duration; awaitingSegment = true;
    }
    if (line && !line.startsWith("#")) {
      if (!awaitingSegment) throw new Error("回放清单含未声明分片");
      awaitingSegment = false; segments += 1; return resource(line);
    }
    if (/URI=/.test(line) && !/^#EXT-X-(?:KEY|MAP):/.test(line)) throw new Error("回放清单包含未支持的外部资源");
    if (line.startsWith("#EXT-X-KEY:") && !/METHOD=(?:NONE|AES-128)(?:,|$)/.test(line)) throw new Error("回放加密格式暂不支持");
    return line.replace(/URI="([^"]+)"/g, (_, raw) => `URI="${resource(raw)}"`);
  }).join("\n");
  if (awaitingSegment || !segments || resources.length > 15000) throw new Error("回放分片清单不完整或超出限制");
  return { seconds, segments, resources, local, scope: { origin: scope.origin, hostname: scope.hostname, pathPrefix: scope.pathPrefix, resourcePathPrefixes: [...scope.resourcePathPrefixes] } };
}

async function verifyFull(file) {
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-xerror", "-threads", "2", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
}

function cleanupTransient(directory) {
  if (!directory || !fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^asset-\d{5}\.[a-z0-9]{1,8}(?:\.part)?$/i.test(name) && !["local.m3u8", "replay.processing.mp4"].includes(name)) continue;
    const file = path.join(directory, name);
    if (require("../backup115/leases").lockedPath(file)) continue;
    try { fs.unlinkSync(file); removed += 1; } catch {}
  }
  const plan = path.join(directory, "plan.json");
  // The plan contains completed-segment hashes. Once those segments are gone,
  // keeping the plan would make a retry reference missing local resources.
  if (!require("../backup115/leases").lockedPath(plan)) { try { fs.unlinkSync(plan); } catch {} }
  return removed;
}

async function download({ liveId, directory, onProgress = () => {}, getReplay = replay.getReplay, request = proxy.upstreamRequest, verify = true }) {
  if (!/^\d{1,30}$/.test(String(liveId))) throw new Error("无效直播 ID");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const final = path.join(directory, "verified.mp4");
  const completeFile = path.join(directory, "complete.json");
  if (fs.existsSync(completeFile) && fs.existsSync(final)) {
    const complete = JSON.parse(fs.readFileSync(completeFile));
    if (complete.liveId === String(liveId) && complete.sha256 === await digest(final)) {
      if (verify && complete.verification === "fast") {
        await verifyFull(final);
        complete.verification = "full";
        atomicJson(completeFile, complete);
      }
      return { ...complete, filePath: final };
    }
    throw new Error("已下载回放校验摘要不匹配，请检查缓存文件");
  }
  requireSpace(directory);
  const planFile = path.join(directory, "plan.json");
  let plan;
  if (fs.existsSync(planFile)) plan = JSON.parse(fs.readFileSync(planFile));
  else {
    const detail = await getReplay(String(liveId));
    if (String(detail.replay?.liveId) !== String(liveId) || !detail.streamUrl) throw new Error("同场官方回放暂不可用");
    let url = proxy.validateSourceUrl(detail.streamUrl);
    const scope = proxy.scopeFor(url);
    for (let depth = 0; depth < 4; depth += 1) {
      const { response, finalUrl } = await request(url.href, {}, { scope });
      if (response.statusCode !== 200) { response.resume(); throw new Error("官方回放清单暂不可下载"); }
      const chunks = []; let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > proxy.MANIFEST_MAX_BYTES) { response.destroy(); throw new Error("官方回放清单过大"); }
        chunks.push(chunk);
      }
      const text = proxy.decodeManifest(Buffer.concat(chunks), response.headers["content-encoding"]);
      if (text.includes("#EXT-X-STREAM-INF:")) {
        if (/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/.test(text)) throw new Error("回放独立音轨格式暂不支持");
        proxy.authorizeManifestResources(text, finalUrl, { scope });
        const lines = text.split(/\r?\n/); const variants = [];
        lines.forEach((line, index) => { if (line.startsWith("#EXT-X-STREAM-INF:") && lines[index + 1]) variants.push({ bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1]) || 0, uri: lines[index + 1].trim() }); });
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        if (!variants.length) throw new Error("回放码率清单无效");
        url = proxy.validateSourceUrl(new URL(variants[0].uri, finalUrl), scope); continue;
      }
      plan = { ...mediaPlan(text, finalUrl, scope), liveId: String(liveId), completed: {} };
      atomicJson(planFile, plan); break;
    }
  }
  if (!plan || plan.liveId !== String(liveId)) throw new Error("回放清单与直播 ID 不符");
  if (!Array.isArray(plan.resources) || plan.resources.some(resource => !/^asset-\d{5}\.[a-z0-9]{1,8}$/i.test(resource.name))) throw new Error("回放缓存资源名称无效");
  const scope = { ...plan.scope, resourcePathPrefixes: new Set(plan.scope.resourcePathPrefixes) };
  let next = 0, completed = 0, totalBytes = 0, failed = false;
  // Four bounded workers reduce exposure to deletion while retaining completed resources.
  async function worker() {
    while (!failed && next < plan.resources.length) {
      const resource = plan.resources[next++];
      const destination = path.join(directory, resource.name);
      const saved = plan.completed[resource.name];
      if (saved && fs.existsSync(destination) && fs.statSync(destination).size === saved.bytes && await digest(destination) === saved.sha256) {
        completed += 1; totalBytes += saved.bytes; onProgress({ completed, total: plan.resources.length, bytes: totalBytes }); continue;
      }
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const temporary = `${destination}.part`;
        try {
          requireSpace(directory);
          const { response } = await request(resource.url, {}, { scope });
          if (response.statusCode !== 200) { response.resume(); throw new Error("官方回放分片失效或下载失败，原录像已保留"); }
          const expected = Number(response.headers["content-length"]);
          const hash = crypto.createHash("sha256"); let bytes = 0, checked = 0;
          await pipeline(response, new Transform({ transform(chunk, _, done) {
            bytes += chunk.length; hash.update(chunk);
            if (bytes > 128 * 1024 * 1024) return done(new Error("回放单个分片超出大小限制"));
            try { if (bytes - checked > 4 * 1024 * 1024) { requireSpace(directory); checked = bytes; } done(null, chunk); } catch (error) { done(error); }
          } }), fs.createWriteStream(temporary, { mode: 0o600 }));
          if (!bytes || Number.isFinite(expected) && expected > 0 && bytes !== expected || response.complete === false) throw new Error("回放分片尚未完整下载");
          // Open for read+write: fsync on a read-only descriptor fails on Windows.
          const fd = fs.openSync(temporary, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, destination);
          plan.completed[resource.name] = { bytes, sha256: hash.digest("hex") }; atomicJson(planFile, plan);
          completed += 1; totalBytes += bytes; onProgress({ completed, total: plan.resources.length, bytes: totalBytes });
          lastError = null; break;
        } catch (error) { lastError = error; try { fs.unlinkSync(temporary); } catch {} }
      }
      if (lastError) { failed = true; throw lastError; }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
  if (completed !== plan.resources.length) throw new Error("回放分片未全部下载，不能替换");
  // All resources are now persisted. No further requests to Pocket48 are needed.
  onProgress({ completed, total: plan.resources.length, bytes: totalBytes, verifying: true });
  requireSpace(directory, totalBytes * 1.1);
  const playlist = path.join(directory, "local.m3u8");
  fs.writeFileSync(playlist, plan.local, { mode: 0o600 });
  const temporary = path.join(directory, "replay.processing.mp4");
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-v", "error", "-y", "-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-i", playlist, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", temporary]);
  const info = await probe(temporary);
  const seconds = Number(info.format.duration);
  if (Math.abs(seconds - plan.seconds) > Math.max(2, plan.seconds * 0.002)) throw new Error("回放文件时长与完整分片清单不符，原录像已保留");
  if (verify) await verifyFull(temporary);
  // Open for read+write: fsync on a read-only descriptor fails on Windows.
  const fd = fs.openSync(temporary, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (require("../backup115/leases").lockedPath(final) || require("../backup115/leases").lockedPath(temporary)) throw Object.assign(new Error("该回放正在备份到115，请等待或取消备份后再替换"), { statusCode: 409 });
  fs.renameSync(temporary, final);
  const complete = { liveId: String(liveId), durationSeconds: seconds, manifestDuration: plan.seconds, segments: plan.segments, size: fs.statSync(final).size, sha256: await digest(final), downloadedAt: new Date().toISOString(), verification: verify ? "full" : "fast", streams: info.streams.map(({ codec_type, codec_name, width, height }) => ({ codec_type, codec_name, width, height })) };
  atomicJson(completeFile, complete);
  for (const resource of plan.resources) { const file = path.join(directory, resource.name); if (!require("../backup115/leases").lockedPath(file)) { try { fs.unlinkSync(file); } catch {} } }
  // Signed resource addresses are no longer required after a verified local copy exists.
  for (const file of [planFile, playlist]) if (!require("../backup115/leases").lockedPath(file)) fs.unlinkSync(file);
  return { ...complete, filePath: final };
}

const activeDownloads = new Map();
function downloadShared(options) {
  const key = path.resolve(options.directory);
  const active = activeDownloads.get(key);
  if (active) {
    if (options.verify !== false && active.verify === false) return active.job.then(() => downloadShared(options));
    return active.job;
  }
  const entry = { verify: options.verify !== false, job: null };
  entry.job = Promise.resolve().then(() => module.exports.download(options)).finally(() => {
    if (activeDownloads.get(key) === entry) activeDownloads.delete(key);
  });
  activeDownloads.set(key, entry);
  return entry.job;
}

module.exports = { download, downloadShared, verifyFull, probe, digest, atomicJson, mediaPlan, requireSpace, cleanupTransient };
