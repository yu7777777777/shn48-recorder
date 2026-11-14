"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { run } = require("../../lib/cli");
const manager = require("./manager");
const store = require("../../lib/store");
const root = process.env.COVERS_DIR || path.join(store.dataDir, "covers");
const pending = new Map(), plans = new Map();
let work = Promise.resolve();
const PLAN_VERSION = 2;
const SOURCES = { original: "原直播封面", smart: "智能选帧", template: "成员模板", upload: "自定义上传" };
const activeStatuses = ["queued", "waiting_credentials", "uploading", "paused_recording"];
function serial(task) { const result = work.then(task); work = result.catch(() => {}); return result; }
function name() { return `${crypto.randomBytes(16).toString("hex")}.jpg`; }
function file(value) {
  if (!/^[a-f0-9]{32}\.jpg$/.test(value || "")) throw new Error("Invalid cover");
  return path.resolve(root, value);
}
function url(recording) { return recording.coverFile ? `/api/admin/recordings/${encodeURIComponent(recording.id)}/cover?v=${recording.coverFile}` : ""; }
function candidateUrl(recording, candidate) { return `/api/admin/recordings/${encodeURIComponent(recording.id)}/cover-candidates/${candidate.file}`; }
function locked(recording) { return manager.getQueue().some(q => q.recordingId === recording.id && activeStatuses.includes(q.status)); }
function assertEditable(recording, allowQueued = false) {
  if (recording.status !== "done") throw new Error("请等待录像归档完成");
  if (!allowQueued && locked(recording)) { const error = new Error("请等待上传队列完成后再修改封面"); error.statusCode = 409; throw error; }
}
function settings() { return store.load("cover_settings", { theme: "dark", members: [] }); }
function saveSettings(value) {
  if (!["dark", "light"].includes(value.theme)) throw new Error("请选择深色或浅色模板");
  const next = { ...settings(), theme: value.theme };
  store.save("cover_settings", next); return next;
}
function members() {
  const map = new Map(settings().members.map(m => [String(m.memberId), { ...m }]));
  for (const r of manager.getRecordings()) {
    if (!r.memberId || map.has(String(r.memberId))) continue;
    map.set(String(r.memberId), { memberId: String(r.memberId), memberName: r.memberName || String(r.memberId), photoFile: null });
  }
  return [...map.values()].sort((a, b) => a.memberName.localeCompare(b.memberName, "zh-CN"));
}
function imageBytes(image) {
  if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error("请选择 JPG、PNG 或 WebP 图片");
  const bytes = Buffer.from(image.split(",")[1], "base64");
  if (!bytes.length || bytes.length > 1400000) throw new Error("图片请小于 1.4 MB");
  return bytes;
}
async function python(job, dir) {
  const input = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(input, JSON.stringify(job));
  try {
    const bin = process.env.COVER_PYTHON_BIN || process.env.OFFLINE_PYTHON || (process.platform === "win32" ? "python" : "/opt/asr-venv/bin/python");
    const result = await run(bin, [path.join(__dirname, "cover-render.py"), input], { timeoutMs: 90000 });
    return JSON.parse(result.stdout);
  } finally { fs.rmSync(input, { force: true }); }
}
function tempDir() { fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "work-")); }
async function saveMember(memberId, { memberName, image, clearPhoto = false }) {
  if (!/^[\w-]{1,80}$/.test(memberId)) throw new Error("无效的成员 ID");
  if (typeof memberName !== "string" || !memberName.trim() || memberName.length > 100) throw new Error("请填写成员姓名（最多 100 字）");
  const bytes = image ? imageBytes(image) : null;
  return serial(async () => {
    const dir = tempDir(), value = settings();
    try {
      let member = value.members.find(m => m.memberId === memberId);
      if (!member) { member = { memberId }; value.members.push(member); }
      let photoFile = clearPhoto ? null : member.photoFile || null;
      if (bytes) {
        const input = path.join(dir, "photo.input"); fs.writeFileSync(input, bytes);
        photoFile = name();
        await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-vf", "scale=960:960:force_original_aspect_ratio=decrease,setsar=1", file(photoFile)]);
      }
      Object.assign(member, { memberName: memberName.trim(), photoFile });
      store.save("cover_settings", value); return member;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
function safeAssetUrl(value) {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port && !["80", "443"].includes(u.port)) return null;
    if (!["48.cn", "snh48.com"].some(host => u.hostname === host || u.hostname.endsWith(`.${host}`))) return null;
    if (/default|placeholder|no[_-]?image|loading/i.test(u.pathname)) return null;
    return u.toString();
  } catch { return null; }
}
async function downloadAsset(value, target) {
  let address = safeAssetUrl(value);
  if (!address) throw new Error("直播封面地址不可用");
  const signal = AbortSignal.timeout(10000);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(address, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      address = safeAssetUrl(new URL(response.headers.get("location") || "", address).toString());
      await response.body?.cancel();
      if (!address) throw new Error("直播封面跳转地址不可用");
      continue;
    }
    if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")) { await response.body?.cancel(); throw new Error("原直播封面下载失败"); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 6000000) throw new Error("原直播封面过大"); chunks.push(chunk); }
    fs.writeFileSync(target, Buffer.concat(chunks)); return;
  }
  throw new Error("直播封面跳转过多");
}
async function metadata(recording) {
  if (recording.source !== "pocket48" || !recording.liveId) return;
  if (recording.liveCoverUrl && recording.liveType !== undefined && recording.liveType !== null) return;
  let timer;
  try {
    const value = await Promise.race([require("../pocket48/replay").getReplay(recording.liveId), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("回放信息超时")), 10000); })]);
    manager.updateRecording(recording.id, {
      liveCoverUrl: value.replay.cover || recording.liveCoverUrl || "",
      memberAvatarUrl: value.replay.member?.avatar || recording.memberAvatarUrl || "",
      liveType: value.replay.liveType ?? recording.liveType ?? null,
      liveMode: value.replay.liveMode ?? recording.liveMode ?? null,
    });
  } catch { /* Missing replay does not prevent a local cover. */ }
  finally { clearTimeout(timer); }
}
function templateData(recording) {
  let date = "";
  try { date = new Intl.DateTimeFormat("sv-SE", { timeZone: process.env.RECORDING_TIME_ZONE || "Asia/Shanghai" }).format(new Date(recording.startedAt || recording.createdAt)); } catch {}
  return { memberName: recording.memberName || "直播录像", title: recording.liveTitle || recording.title || "直播回放", date, source: recording.source, theme: settings().theme };
}
async function buildPlan(recording, { refresh = false, frames = true } = {}) {
  if (recording.status !== "done") throw new Error("请等待录像归档完成");
  await metadata(recording);
  const styleKey = crypto.createHash("sha256").update(JSON.stringify({ ...templateData(recording), photo: settings().members.find(m => String(m.memberId) === String(recording.memberId))?.photoFile })).digest("hex");
  if (!refresh && recording.coverPlanVersion === PLAN_VERSION && recording.coverPlanKey === styleKey && (!frames || recording.coverPlanFrames) && recording.coverCandidates?.length && recording.coverCandidates.every(c => fs.existsSync(file(c.file)))) return recording.coverCandidates;
  const dir = tempDir(), outputs = [], inputs = [];
  try {
    if (recording.liveCoverUrl) {
      const input = path.join(dir, "original.input");
      try {
        await downloadAsset(recording.liveCoverUrl, input);
        const decoded = path.join(dir, "original.jpg");
        await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", "-vf", "scale=960:960:force_original_aspect_ratio=decrease", decoded]);
        inputs.push({ file: decoded, source: "original" });
      } catch { /* Continue with local frames. */ }
    }
    let duration = Number(recording.durationSeconds) || 0;
    if (frames && recording.mediaType !== "audio" && recording.filePath && fs.existsSync(recording.filePath)) {
      try {
        const probe = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", recording.filePath]);
        const media = JSON.parse(probe.stdout); duration = Number(media.format?.duration) || duration;
        if (duration > 0 && media.streams?.some(s => s.codec_type === "video")) {
          for (let i = 0; i < 24; i++) {
            const time = Math.min(duration * (0.06 + i * 0.84 / 23), Math.max(0, duration - 0.1));
            const input = path.join(dir, `frame-${i}.jpg`);
            try {
              await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-y", "-ss", String(time), "-i", recording.filePath, "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease,setsar=1", "-threads", "1", input], { timeoutMs: 15000 });
              if (fs.existsSync(input) && fs.statSync(input).size) inputs.push({ file: input, source: "smart", time: Math.round(time * 10) / 10 });
            } catch { /* Skip corrupt samples. */ }
          }
        }
      } catch { /* Audio/unavailable video falls back to template. */ }
    }
    const scored = inputs.length ? await python({ mode: "analyze", images: inputs, expectedFace: recording.source === "pocket48" || Boolean(recording.memberId) }, dir) : [];
    const original = scored.find(i => i.source === "original" && i.acceptable);
    const selected = [];
    for (const item of scored.filter(i => i.source === "smart").sort((a, b) => Number(b.acceptable) - Number(a.acceptable) || b.score - a.score)) {
      if (selected.some(previous => {
        let v = BigInt(item.hash) ^ BigInt(previous.hash), count = 0;
        while (v) { count++; v &= v - 1n; } return count < 7;
      })) continue;
      selected.push(item); if (selected.length === 6) break;
    }
    const candidates = [];
    for (const item of [...(original ? [original] : []), ...selected]) {
      const output = name(); outputs.push(output);
      await python({ mode: "render", style: item.source === "smart" ? "template" : "plain", input: item.file, output: file(output), ...templateData(recording) }, dir);
      candidates.push({ file: output, source: item.source, time: item.time, acceptable: item.acceptable, score: item.score, reason: item.reason, label: SOURCES[item.source] });
    }
    const member = settings().members.find(m => String(m.memberId) === String(recording.memberId));
    let photo = member?.photoFile && fs.existsSync(file(member.photoFile)) ? file(member.photoFile) : null;
    if (!photo && recording.memberAvatarUrl) {
      try { photo = path.join(dir, "avatar.input"); await downloadAsset(recording.memberAvatarUrl, photo); } catch { photo = null; }
    }
    const output = name(); outputs.push(output);
    try { await python({ mode: "render", style: "template", input: photo, output: file(output), ...templateData(recording) }, dir); }
    catch (error) {
      if (!photo) throw error;
      photo = null;
      await python({ mode: "render", style: "template", output: file(output), ...templateData(recording) }, dir);
    }
    candidates.push({ file: output, source: "template", acceptable: true, label: SOURCES.template, reason: photo ? "使用成员照片" : "尚未设置成员照片，使用姓名模板" });
    const recommended = original ? candidates[0] : candidates.find(c => c.source === "smart" && c.acceptable) || candidates.at(-1);
    recommended.recommended = true;
    manager.updateRecording(recording.id, { coverCandidates: candidates, coverPlanVersion: PLAN_VERSION, coverPlanKey: styleKey, coverPlanFrames: frames, durationSeconds: duration });
    return candidates;
  } catch (error) {
    for (const output of outputs) fs.rmSync(file(output), { force: true }); throw error;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function prepare(recording, options = {}) {
  if (plans.has(recording.id)) return plans.get(recording.id);
  const task = serial(() => buildPlan(recording, options)); plans.set(recording.id, task);
  return task.finally(() => plans.delete(recording.id));
}
function candidateList(recording, candidates) {
  return candidates.map(c => ({
    ...c,
    url: candidateUrl(recording, c),
    current: c.file === recording.coverFile,
    liveType: recording.liveType ?? null,
    liveMode: recording.liveMode ?? null,
  }));
}
function commit(recording, candidate, allowQueued = false) {
  assertEditable(recording, allowQueued);
  return manager.updateRecording(recording.id, { coverFile: candidate.file, coverSource: candidate.source, coverTime: candidate.time ?? null, coverError: null, coverUpdatedAt: new Date().toISOString(), coverSyncPending: Boolean(recording.draftId) });
}
async function generate(recording, { next = false, image, source = "auto", candidateFile, refresh = false, allowQueued = false } = {}) {
  if (pending.has(recording.id)) { const error = new Error("封面正在生成，请稍后重试"); error.statusCode = 409; throw error; }
  if (!next && !image && !candidateFile && source === "auto" && !refresh && recording.coverFile && fs.existsSync(file(recording.coverFile))) return recording;
  assertEditable(recording, allowQueued);
  if (!["auto", "original", "smart", "template"].includes(source)) throw new Error("无效的封面来源");
  const bytes = image ? imageBytes(image) : null;
  const task = (async () => {
    if (bytes) return serial(async () => {
      const dir = tempDir(), output = name();
      try {
        const input = path.join(dir, "upload.input"); fs.writeFileSync(input, bytes);
        await python({ mode: "render", style: "plain", input, output: file(output) }, dir);
        return commit(recording, { file: output, source: "upload" }, allowQueued);
      } catch (error) { fs.rmSync(file(output), { force: true }); throw error; }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    const candidates = await prepare(recording, { refresh, frames: source !== "template" });
    let candidate;
    if (candidateFile) candidate = candidates.find(c => c.file === candidateFile);
    else if (next) {
      const choices = candidates.filter(c => c.source === "smart" && c.acceptable);
      const index = choices.findIndex(c => c.file === recording.coverFile);
      candidate = choices[(index + 1) % choices.length] || candidates.find(c => c.source === "template");
    } else candidate = source === "auto" ? candidates.find(c => c.recommended) : candidates.find(c => c.source === source && c.acceptable);
    if (!candidate) throw new Error("该来源没有可用封面，请选择其他候选");
    return commit(recording, candidate, allowQueued);
  })();
  pending.set(recording.id, task);
  try { return await task; } finally { pending.delete(recording.id); }
}
const batch = { status: "idle", total: 0, completed: 0, failed: 0, skipped: 0, errors: [] };
function startBatch(ids) {
  if (batch.status === "running") throw new Error("批量封面任务正在运行");
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== "string")) throw new Error("每批请选择 1–100 条录像");
  const unique = [...new Set(ids)];
  Object.assign(batch, { status: "running", total: unique.length, completed: 0, failed: 0, skipped: 0, errors: [] });
  void (async () => {
    for (const id of unique) {
      const recording = manager.getRecording(id);
      if (!recording || recording.status !== "done" || locked(recording) || recording.draftId || recording.uploadStatus === "done") { batch.skipped++; continue; }
      try { await generate(recording, { refresh: true }); batch.completed++; }
      catch (error) { batch.failed++; batch.errors.push({ id, error: error.message }); }
    }
    batch.status = "done";
  })();
  return { ...batch };
}
module.exports = { generate, prepare, candidateList, candidateUrl, file, url, locked, assertEditable, settings, saveSettings, members, saveMember, startBatch, batch, _internals: { safeAssetUrl, imageBytes, buildPlan, commit, SOURCES } };
