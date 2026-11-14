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
// Plan persistence is throttled to one flush per interval (dirty flag plus a
// checkpoint timer); the flush itself is always a synchronous atomic write.
const PLAN_FLUSH_MS = 3000;
// Business failures thrown by this module are preset Chinese sentences that may
// be shown to a public visitor. Raw fs/network/spawn errors never get this
// marker, so routes can fall back to a generic message without leaking URLs,
// paths or stack details.
const preset = message => Object.assign(new Error(message), { preset: true });

function atomicJson(file, value) {
  store.atomicWrite(file, value);
}
function freeBytes(dir) {
  const stat = fs.statfsSync(dir, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}
function requireSpace(dir, additional = 0) {
  if (freeBytes(dir) < RESERVE + additional) throw preset("磁盘空间不足，已保留原录像，请清理空间后重试");
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
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(preset("回放视频处理或完整解码校验失败")); });
  });
}
async function probe(file) {
  const raw = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], 60000);
  const info = JSON.parse(raw);
  if (!info.streams?.some(s => s.codec_type === "video") || !(Number(info.format?.duration) > 0)) throw preset("视频缺少有效画面或时长");
  return info;
}
function mediaPlan(text, baseUrl, scope) {
  if (!text.startsWith("#EXTM3U") || !text.includes("#EXT-X-ENDLIST")) throw preset("官方回放尚未生成完整清单");
  if (/#EXT-X-(?:GAP|BYTERANGE)|BYTERANGE=/.test(text)) throw preset("回放含缺失分片或暂不支持的分片格式");
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
      if (awaitingSegment) throw preset("回放分片清单不完整");
      const duration = Number(line.slice(8).split(",")[0]);
      if (!(duration > 0)) throw preset("回放分片时长无效");
      seconds += duration; awaitingSegment = true;
    }
    if (line && !line.startsWith("#")) {
      if (!awaitingSegment) throw preset("回放清单含未声明分片");
      awaitingSegment = false; segments += 1; return resource(line);
    }
    if (/URI=/.test(line) && !/^#EXT-X-(?:KEY|MAP):/.test(line)) throw preset("回放清单包含未支持的外部资源");
    if (line.startsWith("#EXT-X-KEY:") && !/METHOD=(?:NONE|AES-128)(?:,|$)/.test(line)) throw preset("回放加密格式暂不支持");
    return line.replace(/URI="([^"]+)"/g, (_, raw) => `URI="${resource(raw)}"`);
  }).join("\n");
  if (awaitingSegment || !segments || resources.length > 15000) throw preset("回放分片清单不完整或超出限制");
  return { seconds, segments, resources, local, scope: { origin: scope.origin, hostname: scope.hostname, pathPrefix: scope.pathPrefix, resourcePathPrefixes: [...scope.resourcePathPrefixes] } };
}

async function verifyFull(file) {
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-xerror", "-threads", "2", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
}

// Reset each discontinuity independently. Passing the whole HLS timeline to a
// single stream-copy can collapse timestamps at reconnects (and shift audio).
function continuityPeriods(local) {
  const lines = local.split(/\r?\n/).map(line => line.trim());
  const header = lines.filter(line => /^#EXT-X-(?:VERSION:|TARGETDURATION:|PLAYLIST-TYPE:|INDEPENDENT-SEGMENTS$)/.test(line));
  const sequenceLine = lines.find(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  let sequence = BigInt(sequenceLine?.slice(22) || "0"), key = "", map = "", body = [], seconds = 0, count = 0, maximum = 0;
  const periods = [];
  function flush() {
    if (count) periods.push({ local: ["#EXTM3U", ...header, `#EXT-X-MEDIA-SEQUENCE:${sequence}`, ...body, "#EXT-X-ENDLIST", ""].join("\n"), seconds, segments: count, maximum });
    sequence += BigInt(count); body = [key, map].filter(Boolean); seconds = 0; count = 0; maximum = 0;
  }
  for (const line of lines) {
    if (line === "#EXT-X-DISCONTINUITY") { flush(); continue; }
    if (!line || line === "#EXTM3U" || /^#EXT-X-(?:ENDLIST|MEDIA-SEQUENCE:|DISCONTINUITY-SEQUENCE:|VERSION:|TARGETDURATION:|PLAYLIST-TYPE:|INDEPENDENT-SEGMENTS$)/.test(line)) continue;
    if (line.startsWith("#EXT-X-KEY:")) key = line;
    if (line.startsWith("#EXT-X-MAP:")) map = line;
    if (line.startsWith("#EXTINF:")) { const value = Number(line.slice(8).split(",")[0]); seconds += value; maximum = Math.max(maximum, value); }
    if (!line.startsWith("#")) count += 1;
    body.push(line);
  }
  flush();
  return periods;
}
async function packetCounts(file, playlist = false) {
  const args = ["-v", "error", ...(playlist ? ["-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL"] : []), "-i", file, "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets", "-of", "json"];
  const info = JSON.parse(await run(process.env.FFPROBE_BIN || "ffprobe", args));
  const streams = info.streams || [];
  return [streams.find(s => s.codec_type === "video"), ...streams.filter(s => s.codec_type === "audio")].filter(Boolean).map(s => ({ type: s.codec_type, packets: Number(s.nb_read_packets) }));
}
function samePackets(expected, actual) {
  return expected.length > 0 && expected.length === actual.length && expected.every((s, i) => s.type === actual[i].type && s.packets > 0 && s.packets === actual[i].packets);
}
function durationError(manifest, actual) {
  return preset(`回放文件时长与完整分片清单不符（清单 ${manifest.toFixed(2)} 秒，文件 ${actual.toFixed(2)} 秒），原录像已保留`);
}
async function muxPlan(plan, directory, temporary) {
  const mux = (playlist, output) => run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-v", "error", "-y", "-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-i", playlist, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", output]);
  const diagnostics = { liveId: plan.liveId, manifestSeconds: plan.seconds, segments: plan.segments, periods: [], checkedAt: new Date().toISOString() };
  const generated = [];
  try {
    if (!/^#EXT-X-DISCONTINUITY\s*$/m.test(plan.local)) {
      const playlist = path.join(directory, "local.m3u8");
      fs.writeFileSync(playlist, plan.local, { mode: 0o600 });
      await mux(playlist, temporary);
      const info = await probe(temporary), seconds = Number(info.format.duration);
      diagnostics.durationSeconds = seconds;
      if (Math.abs(seconds - plan.seconds) > Math.max(2, plan.seconds * 0.002)) throw durationError(plan.seconds, seconds);
      return info;
    }
    let expected = null, signature = null, duration = 0;
    const periods = continuityPeriods(plan.local);
    for (const [index, period] of periods.entries()) {
      const playlist = path.join(directory, `timeline-${index}.m3u8`), output = path.join(directory, `timeline-${index}.mp4`);
      generated.push(playlist, output);
      fs.writeFileSync(playlist, period.local, { mode: 0o600 });
      const sourcePackets = await packetCounts(playlist, true);
      if (!sourcePackets.some(s => s.type === "video")) throw Object.assign(preset("重连分段需要独立音视频时间轴"), { code: "REPLAY_SEPARATE_TRACKS" });
      await mux(playlist, output);
      const info = await probe(output), seconds = Number(info.format.duration);
      const outputPackets = await packetCounts(output);
      const measured = { manifestSeconds: period.seconds, durationSeconds: seconds, segments: period.segments, sourcePackets, outputPackets };
      diagnostics.periods.push(measured);
      if (!samePackets(sourcePackets, outputPackets)) throw Object.assign(preset("回放合并后画面或音频包数量不符，原录像已保留"), { code: "REPLAY_SEPARATE_TRACKS" });
      // Some official reconnect playlists undercount one boundary segment. Only
      // allow that bounded difference after proving every source packet survived.
      if (Math.abs(seconds - period.seconds) > Math.max(2, period.seconds * 0.002, Math.min(period.maximum + 0.5, period.seconds * 0.01))) throw durationError(period.seconds, seconds);
      const nextSignature = JSON.stringify(info.streams.filter(s => ["video", "audio"].includes(s.codec_type)).map(({ codec_type, codec_name, width, height, sample_rate, channels }) => ({ codec_type, codec_name, width, height, sample_rate, channels })));
      if (signature !== null && signature !== nextSignature) throw preset("官方回放中途画面或音轨格式变化，原录像已保留");
      signature = nextSignature; duration += seconds;
      if (!expected) expected = sourcePackets.map(s => ({ ...s }));
      else sourcePackets.forEach((s, i) => { expected[i].packets += s.packets; });
    }
    const list = path.join(directory, "timeline-concat.txt"); generated.push(list);
    fs.writeFileSync(list, periods.map((_, index) => `file 'timeline-${index}.mp4'`).join("\n"), { mode: 0o600 });
    await run(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", temporary]);
    const info = await probe(temporary), seconds = Number(info.format.duration), actual = await packetCounts(temporary);
    diagnostics.durationSeconds = seconds; diagnostics.expectedPackets = expected; diagnostics.actualPackets = actual;
    if (!samePackets(expected || [], actual)) throw preset("回放拼接后画面或音频包数量不符，原录像已保留");
    if (Math.abs(seconds - duration) > Math.max(2, duration * 0.002)) throw durationError(duration, seconds);
    return info;
  } catch (error) {
    if (error.code === "REPLAY_SEPARATE_TRACKS") {
      try { return await require("./replay-timeline-tracks")({ periods: continuityPeriods(plan.local), directory, temporary, run, packetCounts, samePackets, preset, diagnostics }); }
      catch (fallbackError) { diagnostics.error = fallbackError.preset ? fallbackError.message : "独立音视频时间轴校验失败"; throw fallbackError; }
    }
    diagnostics.error = error.preset ? error.message : "回放媒体校验失败"; throw error;
  }
  finally {
    atomicJson(path.join(directory, "validation.json"), diagnostics);
    for (const file of generated) { try { fs.unlinkSync(file); } catch {} }
  }
}

function cleanupTransient(directory) {
  if (!directory || !fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^asset-\d{5}\.[a-z0-9]{1,8}(?:\.part)?$/i.test(name) && !/^timeline-(?:\d+\.(?:mp4|m3u8)|concat\.txt|track-(?:source-\d+\.m3u8|(?:video|audio)(?:-\d+\.mp4|\.ffconcat)))$/.test(name) && !["local.m3u8", "replay.processing.mp4"].includes(name)) continue;
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

function download(options) { return downloadAttempt(options); }

async function downloadAttempt(options, refreshRemaining = 1, refreshPlan = false) {
  const { liveId, directory, onProgress = () => {}, getReplay = replay.getReplay, request = proxy.upstreamRequest, verify = true } = options;
  if (!/^\d{1,30}$/.test(String(liveId))) throw preset("无效直播 ID");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const final = path.join(directory, "verified.mp4");
  const completeFile = path.join(directory, "complete.json");
  if (!options.refresh && fs.existsSync(completeFile) && fs.existsSync(final)) {
    const complete = JSON.parse(fs.readFileSync(completeFile));
    if (complete.liveId === String(liveId) && complete.sha256 === await digest(final)) {
      if (verify && complete.verification === "fast") {
        await verifyFull(final);
        complete.verification = "full";
        atomicJson(completeFile, complete);
      }
      return { ...complete, filePath: final };
    }
    throw preset("已下载回放校验摘要不匹配，请检查缓存文件");
  }
  requireSpace(directory);
  const planFile = path.join(directory, "plan.json");
  let plan;
  if (!refreshPlan && !options.refresh && fs.existsSync(planFile)) plan = JSON.parse(fs.readFileSync(planFile));
  else {
    const detail = await getReplay(String(liveId));
    if (String(detail.replay?.liveId) !== String(liveId) || !detail.streamUrl) throw preset("同场官方回放暂不可用");
    let url = proxy.validateSourceUrl(detail.streamUrl);
    const scope = proxy.scopeFor(url);
    for (let depth = 0; depth < 4; depth += 1) {
      const { response, finalUrl } = await request(url.href, {}, { scope });
      if (response.statusCode !== 200) { response.resume(); throw preset("官方回放清单暂不可下载"); }
      const chunks = []; let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > proxy.MANIFEST_MAX_BYTES) { response.destroy(); throw preset("官方回放清单过大"); }
        chunks.push(chunk);
      }
      const text = proxy.decodeManifest(Buffer.concat(chunks), response.headers["content-encoding"]);
      if (text.includes("#EXT-X-STREAM-INF:")) {
        if (/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/.test(text)) throw preset("回放独立音轨格式暂不支持");
        proxy.authorizeManifestResources(text, finalUrl, { scope });
        const lines = text.split(/\r?\n/); const variants = [];
        lines.forEach((line, index) => { if (line.startsWith("#EXT-X-STREAM-INF:") && lines[index + 1]) variants.push({ bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1]) || 0, uri: lines[index + 1].trim() }); });
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        if (!variants.length) throw preset("回放码率清单无效");
        url = proxy.validateSourceUrl(new URL(variants[0].uri, finalUrl), scope); continue;
      }
      plan = { ...mediaPlan(text, finalUrl, scope), liveId: String(liveId), completed: {} };
      atomicJson(planFile, plan); break;
    }
  }
  if (!plan || plan.liveId !== String(liveId)) throw preset("回放清单与直播 ID 不符");
  if (!Array.isArray(plan.resources) || plan.resources.some(resource => !/^asset-\d{5}\.[a-z0-9]{1,8}$/i.test(resource.name))) throw preset("回放缓存资源名称无效");
  const scope = { ...plan.scope, resourcePathPrefixes: new Set(plan.scope.resourcePathPrefixes) };
  // Plan persistence is throttled: a finished segment only marks the plan dirty,
  // and the plan is flushed at most once per PLAN_FLUSH_MS (checkpoint timer
  // included). store.atomicWrite is synchronous, so a flush always captures every
  // completion so far with no cross-promise write race. The unconditional final
  // flush below runs before any outcome (mux, refresh or failure) is decided, so
  // "completed segments survive for resume" keeps holding.
  let planDirty = false, planFlushedAt = Date.now(), planFlushTimer = null;
  function flushPlan() {
    if (planFlushTimer) { clearTimeout(planFlushTimer); planFlushTimer = null; }
    if (!planDirty) return;
    planDirty = false; planFlushedAt = Date.now();
    atomicJson(planFile, plan);
  }
  function markPlanDirty() {
    planDirty = true;
    const elapsed = Date.now() - planFlushedAt;
    if (elapsed >= PLAN_FLUSH_MS) flushPlan();
    else if (!planFlushTimer) planFlushTimer = setTimeout(flushPlan, PLAN_FLUSH_MS - elapsed).unref?.();
  }
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
          if (response.statusCode !== 200) {
            response.resume();
            const error = preset("官方回放分片失效或下载失败，原录像已保留");
            if ([401, 403, 404, 410].includes(response.statusCode)) error.code = "REPLAY_RESOURCE_EXPIRED";
            throw error;
          }
          const expected = Number(response.headers["content-length"]);
          const hash = crypto.createHash("sha256"); let bytes = 0, checked = 0;
          await pipeline(response, new Transform({ transform(chunk, _, done) {
            bytes += chunk.length; hash.update(chunk);
            if (bytes > 128 * 1024 * 1024) return done(preset("回放单个分片超出大小限制"));
            try { if (bytes - checked > 4 * 1024 * 1024) { requireSpace(directory); checked = bytes; } done(null, chunk); } catch (error) { done(error); }
          } }), fs.createWriteStream(temporary, { mode: 0o600 }));
          if (!bytes || Number.isFinite(expected) && expected > 0 && bytes !== expected || response.complete === false) throw preset("回放分片尚未完整下载");
          // Open for read+write: fsync on a read-only descriptor fails on Windows.
          const fd = fs.openSync(temporary, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temporary, destination);
          plan.completed[resource.name] = { bytes, sha256: hash.digest("hex") }; markPlanDirty();
          completed += 1; totalBytes += bytes; onProgress({ completed, total: plan.resources.length, bytes: totalBytes });
          lastError = null; break;
        } catch (error) { lastError = error; try { fs.unlinkSync(temporary); } catch {} }
      }
      if (lastError) { failed = true; throw lastError; }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, worker));
  // Unconditional final flush: every completed segment must be on disk before the
  // attempt's outcome (mux, expiry refresh or failure) is decided, so a retry can
  // always resume from exactly what finished.
  flushPlan();
  const rejected = outcomes.find(outcome => outcome.status === "rejected");
  if (rejected) {
    if (refreshRemaining > 0 && outcomes.filter(outcome => outcome.status === "rejected")
      .every(outcome => outcome.reason?.code === "REPLAY_RESOURCE_EXPIRED")) {
      // All old workers have settled before replacing the plan. Refetch the same
      // live's metadata and reauthorize its manifest/scope. A fresh completed map
      // intentionally redownloads even same-named assets: their bytes may differ.
      return downloadAttempt(options, refreshRemaining - 1, true);
    }
    throw rejected.reason;
  }
  if (completed !== plan.resources.length) throw preset("回放分片未全部下载，不能替换");
  // All resources are now persisted. No further requests to Pocket48 are needed.
  onProgress({ completed, total: plan.resources.length, bytes: totalBytes, verifying: true });
  requireSpace(directory, totalBytes * (/^#EXT-X-DISCONTINUITY\s*$/m.test(plan.local) ? 2.2 : 1.1));
  const playlist = path.join(directory, "local.m3u8");
  const temporary = path.join(directory, "replay.processing.mp4");
  const info = await muxPlan(plan, directory, temporary);
  const seconds = Number(info.format.duration);
  if (verify) await verifyFull(temporary);
  // Open for read+write: fsync on a read-only descriptor fails on Windows.
  const fd = fs.openSync(temporary, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (require("../backup115/leases").lockedPath(final) || require("../backup115/leases").lockedPath(temporary)) throw Object.assign(preset("该回放正在备份到115，请等待或取消备份后再替换"), { statusCode: 409 });
  fs.renameSync(temporary, final);
  const complete = { liveId: String(liveId), durationSeconds: seconds, manifestDuration: plan.seconds, timelineVersion: 1, segments: plan.segments, size: fs.statSync(final).size, sha256: await digest(final), downloadedAt: new Date().toISOString(), verification: verify ? "full" : "fast", streams: info.streams.map(({ codec_type, codec_name, width, height }) => ({ codec_type, codec_name, width, height })) };
  atomicJson(completeFile, complete);
  for (const resource of plan.resources) { const file = path.join(directory, resource.name); if (!require("../backup115/leases").lockedPath(file)) { try { fs.unlinkSync(file); } catch {} } }
  // Signed resource addresses are no longer required after a verified local copy exists.
  for (const file of [planFile, playlist]) if (fs.existsSync(file) && !require("../backup115/leases").lockedPath(file)) fs.unlinkSync(file);
  return { ...complete, filePath: final };
}

const activeDownloads = new Map();
function downloadShared(options) {
  const key = path.resolve(options.directory);
  const active = activeDownloads.get(key);
  if (active) {
    if (options.refresh && !active.refresh) return active.job.then(() => downloadShared(options));
    if (options.verify !== false && active.verify === false) return active.job.then(() => downloadShared(options));
    return active.job;
  }
  const entry = { verify: options.verify !== false, refresh: Boolean(options.refresh), job: null };
  entry.job = Promise.resolve().then(() => module.exports.download(options)).finally(() => {
    if (activeDownloads.get(key) === entry) activeDownloads.delete(key);
  });
  activeDownloads.set(key, entry);
  return entry.job;
}

module.exports = { download, downloadShared, verifyFull, probe, digest, atomicJson, mediaPlan, requireSpace, cleanupTransient, continuityPeriods };
