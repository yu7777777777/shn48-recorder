"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const store = require("../../lib/store");
const realProvider = require("./provider");
const ACTIVE = new Set(["queued", "hashing", "uploading", "verifying", "retry_wait", "waiting_credentials"]);
const nowIso = () => new Date().toISOString();
const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, code });
function inside(root, file) { const rel = path.relative(root, file); return Boolean(rel) && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); }
function safeTarget(value) {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || /[\x00-\x1f\\]/.test(value) || value.split("/").some(p => p === "." || p === ".." || p.length > 120)) throw fail("请输入有效的115绝对目录，不能包含上级路径");
  const cleaned = value.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!cleaned) throw fail("请选择专用备份目录，不支持直接备份到网盘根目录");
  return cleaned;
}
function segment(value) { return String(value || "未命名").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+$/, "_").trim().slice(0, 72) || "未命名"; }
function signature(file) { const s = fs.statSync(file); if (!s.isFile() || !Number.isSafeInteger(s.size) || s.size < 1) throw fail("归档文件不存在或为空", 409); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev }; }
function digest(data) { return crypto.createHash("sha1").update(data).digest("hex").toUpperCase(); }
function publicConnection(value = {}) { return { runtimeAvailable: value.runtimeAvailable === true, authorized: value.authorized === true, accountLabel: String(value.accountLabel || "").slice(0, 120), message: String(value.message || "").slice(0, 250) }; }
function createService(options = {}) {
  const manager = options.manager || require("../recorder/manager");
  const provider = options.provider || realProvider;
  const leases = options.leases || require("./leases");
  const dir = path.resolve(options.dir || realProvider.stateDir());
  const root = () => path.resolve(options.root || require("../pocket48/recorder")._internals.recordingsDir());
  const stateFile = path.join(dir, "jobs.json"), settingsFile = path.join(dir, "settings.json");
  const write = options.write || store.atomicWrite;
  let jobs = [], settings = { targetPath: "/48tools归档", autoBackup: false, autoSince: null };
  let connection = { runtimeAvailable: false, authorized: false, message: "请先检查115连接并扫码授权" };
  let corruption = null, running = null, stopped = true, interval, current, qrEpoch = 0;
  const sessions = new Map();
  const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  try {
    jobs = read(stateFile, []); settings = { ...settings, ...read(settingsFile, {}) };
    if (!Array.isArray(jobs) || jobs.length > 10000 || jobs.some(j => !j || typeof j.id !== "string" || !Array.isArray(j.files))) throw Error();
    safeTarget(settings.targetPath);
    for (const j of jobs) {
      if (["hashing", "uploading", "verifying"].includes(j.status)) { j.status = "queued"; j.phase = "等待重启后远端对账"; }
      if (ACTIVE.has(j.status)) leases.acquire(j.id, j.files.map(f => f.localPath));
    }
  } catch { corruption = "115备份任务或设置文件损坏，已停止自动处理；请保留文件并检查磁盘"; }
  function healthy() { if (corruption) throw fail(corruption, 503); }
  function persist(next) { healthy(); write(stateFile, next); jobs = next; }
  function job(id) { return jobs.find(j => j.id === id); }
  function update(id, patch) { const found = job(id); if (!found) throw fail("备份任务不存在", 404); const next = { ...found, ...patch, updatedAt: nowIso() }; persist(jobs.map(j => j.id === id ? next : j)); return next; }
  function dto(j) {
    let state = j.status;
    if (["succeeded", "partial"].includes(state)) {
      try { const rec = manager.getRecording(j.recordingId); if (rec && !["deleted", "merged"].includes(rec.status) && (path.resolve(rec.filePath || "") !== j.source.path || JSON.stringify(signature(j.source.path)) !== JSON.stringify(j.source.stat) || (rec.archiveVersion || null) !== j.source.version)) state = "stale_source"; } catch { state = "stale_source"; }
    }
    return { id: j.id, recordingId: j.recordingId, status: state, phase: j.phase || "", progress: j.progress || 0, totalBytes: j.totalBytes || 0, uploadedBytes: j.uploadedBytes || 0, error: j.error || "", remotePath: j.remotePath || "", verifiedAt: j.verifiedAt || null, createdAt: j.createdAt, updatedAt: j.updatedAt,
      files: j.files.map(f => ({ role: f.role, status: f.status, name: f.name, size: f.size, remoteFileId: f.remote?.fileId || null, error: f.error || "" })) };
  }
  function status() { healthy(); return { settings: { targetPath: settings.targetPath, autoBackup: settings.autoBackup === true }, connection: publicConnection(connection), jobs: jobs.map(dto) }; }
  function saveSettings(input) {
    healthy(); if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["targetPath", "autoBackup"].includes(k))) throw fail("备份设置字段无效");
    if (input.autoBackup !== undefined && typeof input.autoBackup !== "boolean") throw fail("自动备份开关无效");
    if (input.autoBackup === true && !settings.autoBackup && !connection.authorized) throw fail("请先扫码授权115，再开启自动备份", 409);
    const next = { ...settings, targetPath: input.targetPath === undefined ? settings.targetPath : safeTarget(input.targetPath) };
    if (process.env.BACKUP115_REMOTE_ROOT) { const allowed = safeTarget(process.env.BACKUP115_REMOTE_ROOT); if (next.targetPath !== allowed && !next.targetPath.startsWith(allowed + "/")) throw fail("备份目录不在管理员允许的115根目录内"); }
    if (input.autoBackup !== undefined) { next.autoBackup = input.autoBackup; if (input.autoBackup && !settings.autoBackup) next.autoSince = nowIso(); }
    write(settingsFile, next); settings = next; return status().settings;
  }
  function normalizeConnection(value) {
    return { ...publicConnection(value), message: value?.authorized ? "115账号已连接" : value?.runtimeAvailable ? "请扫码授权115" : "115上传环境尚未就绪，请联系管理员", accountId: value?.accountId == null ? "" : String(value.accountId) };
  }
  async function check() {
    healthy();
    try { connection = normalizeConnection(await provider.invoke("check")); }
    catch (e) { connection = { runtimeAvailable: e.code !== "unavailable", authorized: false, message: realProvider.MESSAGES[e.code] || "115连接检查失败，请稍后重试" }; }
    if (connection.authorized) {
      for (const j of jobs.filter(j => j.status === "waiting_credentials")) update(j.id, { status: "queued", error: "", nextRetryAt: null });
      kick();
    }
    return publicConnection(connection);
  }
  async function qrStart(owner) {
    healthy(); if (current) throw fail("请先取消正在进行的备份后再更换115授权", 409);
    for (const [id, s] of sessions) if (s.expiresAt < Date.now() || s.owner === owner) sessions.delete(id);
    if (sessions.size >= 8) throw fail("扫码请求过多，请稍后重试", 429);
    const value = await provider.invoke("qr_start");
    if (!value?.token || !/^https:\/\/(?:115\.com|qrcodeapi\.115\.com)\//i.test(String(value.qrUrl))) throw fail("115二维码响应无效", 502);
    const id = crypto.randomUUID(), expiresAt = Date.now() + Math.min(180, Number(value.expiresIn) || 120) * 1000;
    sessions.set(id, { owner, token: value.token, expiresAt, epoch: qrEpoch });
    const qrDataUrl = await require("qrcode").toDataURL(value.qrUrl, { width: 240, margin: 1 });
    return { sessionId: id, qrDataUrl, expiresAt: new Date(expiresAt).toISOString() };
  }
  async function qrPoll(id, owner) {
    healthy(); const s = sessions.get(id);
    if (!s || s.owner !== owner || s.epoch !== qrEpoch) throw fail("二维码会话不存在或已失效", 404);
    if (s.expiresAt < Date.now()) { sessions.delete(id); return { status: "expired" }; }
    if (s.result) return s.result;
    if (s.pending) return s.pending;
    s.pending = (async () => {
      if (current) throw fail("备份正在运行，请先取消后再更换授权", 409);
      if ([...sessions.values()].some(other => other !== s && other.pending)) throw fail("另一扫码操作正在进行，请稍后重试", 409);
      const result = await provider.invoke("qr_poll", { token: s.token });
      if (s.epoch !== qrEpoch) throw fail("二维码已撤销", 409);
      if (!["waiting", "scanned", "signed_in", "expired", "canceled"].includes(result?.status)) throw fail("二维码状态无效", 502);
      if (result.status === "signed_in") { connection = normalizeConnection(result.connection); s.result = { status: "signed_in", connection: publicConnection(connection) }; kick(); return s.result; }
      if (["expired", "canceled"].includes(result.status)) sessions.delete(id);
      return { status: result.status };
    })();
    try { return await s.pending; } finally { s.pending = null; }
  }
  async function logout() {
    healthy(); if (current || [...sessions.values()].some(s => s.pending)) throw fail("请等待当前操作结束或取消备份后退出115", 409);
    qrEpoch++; sessions.clear();
    await provider.invoke("logout"); connection = { runtimeAvailable: true, authorized: false, message: "115已断开，备份原件不受影响" };
    for (const j of jobs.filter(j => ACTIVE.has(j.status))) update(j.id, { status: "waiting_credentials", error: "请重新扫码授权115" });
    return publicConnection(connection);
  }
  function stable(rec) {
    if (!rec || !["done", "completed", "archived"].includes(rec.status)) throw fail("请等待录像归档完成", 409);
    if (options.stable) options.stable(rec);
    else if (require("../recorder/replay-recovery").busy(rec.id) || require("../recorder/archive-processor").busy?.(rec.id) || require("../recorder/clips").busy(rec.id)) throw fail("请等待归档、剪辑或完整回放替换结束", 409);
  }
  function resolveMain(rec) {
    stable(rec); const base = fs.realpathSync(root()), candidate = path.resolve(rec.filePath || "");
    if (!inside(base, candidate) || !fs.lstatSync(candidate).isFile()) throw fail("归档文件不在允许的录像目录中", 400);
    const real = fs.realpathSync(candidate); if (!inside(base, real)) throw fail("归档文件越过录像目录", 400);
    return { path: real, stat: signature(real), version: rec.archiveVersion || null };
  }
  function metadata(rec) { return Object.fromEntries(["id", "title", "memberId", "memberName", "liveId", "liveTitle", "source", "mediaType", "recordedAt", "startedAt", "endedAt", "archivedAt", "durationSeconds", "archiveVersion", "archiveOrigin"].filter(k => rec[k] !== undefined).map(k => [k, rec[k]])); }
  function snapshot(rec, source) {
    const attachments = [], meta = JSON.stringify(metadata(rec), null, 2);
    attachments.push({ role: "metadata", suffix: ".json", data: Buffer.from(meta) });
    if (/^[\w-]{1,100}$/.test(String(rec.id))) {
      const analysis = store.load("analysis_" + rec.id, null);
      if (Array.isArray(analysis?.segments) && analysis.segments.length) {
        const text = require("../analysis/service").subtitle(analysis.segments);
        if (Buffer.byteLength(text) > 20000000) throw fail("字幕附件过大，请检查字幕内容");
        attachments.push({ role: "subtitle", suffix: ".srt", data: Buffer.from(text) });
      }
    }
    if (rec.coverFile) {
      const cover = require("../recorder/covers").file(rec.coverFile);
      if (fs.existsSync(cover)) { if (fs.statSync(cover).size > 5000000) throw fail("封面附件过大"); attachments.push({ role: "cover", suffix: ".jpg", data: fs.readFileSync(cover) }); }
    }
    const fingerprint = digest(JSON.stringify({ source, attachments: attachments.map(f => [f.role, digest(f.data)]) }));
    return { attachments, fingerprint };
  }
  function enqueueOne(id, automatic = false) {
    healthy(); if (!connection.runtimeAvailable) throw fail("115上传环境未就绪，请先检查连接", 409);
    if (!connection.authorized || !connection.accountId) throw fail("请先在系统设置中扫码连接115", 409);
    if (jobs.length >= 10000) throw fail("备份审计记录已达上限，请先归档审计数据", 429);
    if (jobs.filter(j => ACTIVE.has(j.status)).length >= 300) throw fail("备份队列已满，请等待任务完成", 429);
    const rec = manager.getRecording(String(id)); const source = resolveMain(rec), snap = snapshot(rec, source);
    const existing = jobs.find(j => j.recordingId === String(id) && j.fingerprint === snap.fingerprint && j.accountId === connection.accountId && j.targetPath === settings.targetPath && !(automatic ? ["stale_source"] : ["cancelled", "stale_source"]).includes(j.status));
    if (existing) return dto(existing);
    const jobId = crypto.randomUUID(), fileDir = path.join(dir, "files", jobId);
    fs.mkdirSync(fileDir, { recursive: true, mode: 0o700 });
    const files = [{ role: "media", localPath: source.path, size: source.stat.size, status: "queued", name: "recording" + (path.extname(source.path).toLowerCase() || ".mp4") }];
    for (const a of snap.attachments) { const name = a.role + "-" + digest(a.data).slice(0, 12) + a.suffix, f = path.join(fileDir, name); fs.writeFileSync(f, a.data, { mode: 0o600, flag: "wx" }); files.push({ role: a.role, localPath: f, size: a.data.length, sha1: digest(a.data), status: "queued", name }); }
    const dateValue = new Date(rec.startedAt || rec.recordedAt || rec.endedAt || Date.now());
    const date = Number.isNaN(dateValue.getTime()) ? "未知日期" : dateValue.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const item = { id: jobId, recordingId: String(id), accountId: connection.accountId, targetPath: settings.targetPath, source, fingerprint: snap.fingerprint, folder: segment(rec.memberName || rec.memberId || rec.source) + "/" + date + "-" + segment(rec.id), status: "queued", phase: "等待备份", files, attempts: 0, totalBytes: files.reduce((n, f) => n + f.size, 0), uploadedBytes: 0, progress: 0, createdAt: nowIso(), updatedAt: nowIso(), automatic };
    leases.acquire(jobId, files.map(f => f.localPath));
    try { persist([...jobs, item]); } catch (e) { leases.releaseOwner(jobId); throw e; }
    kick(); return dto(item);
  }
  function enqueue(ids) { healthy(); if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string" || id.length > 100)) throw fail("请选择1到100条有效归档"); const results = [], errors = []; for (const id of [...new Set(ids)]) { try { results.push(enqueueOne(id)); } catch (e) { errors.push({ recordingId: id, error: e.statusCode ? e.message : "备份入队失败，请检查文件或磁盘" }); } } return { jobs: results, errors }; }
  function assertCurrent(id, signal) {
    const j = job(id); if (!j || signal?.aborted || j.status === "cancelled") throw realProvider.failure("cancelled");
    const rec = manager.getRecording(j.recordingId); if (!rec || ["deleted", "merged"].includes(rec.status)) throw realProvider.failure("source_changed");
    const fresh = resolveMain(rec);
    if (JSON.stringify(fresh) !== JSON.stringify(j.source)) throw realProvider.failure("source_changed");
    return j;
  }
  async function hashFile(file, signal) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha1"), stream = fs.createReadStream(file);
      const abort = () => stream.destroy(realProvider.failure("cancelled"));
      if (signal.aborted) return reject(realProvider.failure("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      stream.on("data", data => hash.update(data)); stream.once("error", e => { signal.removeEventListener("abort", abort); reject(e); }); stream.once("end", () => { signal.removeEventListener("abort", abort); resolve(hash.digest("hex").toUpperCase()); });
    });
  }
  async function execute(id, signal) {
    let j = assertCurrent(id, signal);
    if (j.accountId !== connection.accountId) throw realProvider.failure("account_mismatch");
    update(id, { status: "hashing", phase: "计算文件SHA1", error: "", attempts: (j.attempts || 0) + 1 });
    for (let i = 0; i < j.files.length; i++) {
      j = assertCurrent(id, signal); const f = j.files[i];
      const hash = await hashFile(f.localPath, signal); assertCurrent(id, signal);
      if (f.sha1 && f.sha1 !== hash) throw realProvider.failure("source_changed");
      update(id, { files: job(id).files.map((x, n) => n === i ? { ...x, sha1: hash } : x) });
    }
    j = job(id); const remotePath = j.targetPath + "/" + j.folder + "/" + j.files[0].sha1.slice(0, 16);
    update(id, { remotePath });
    let completedBytes = 0, failedAttachments = false;
    for (let i = 0; i < j.files.length; i++) {
      j = assertCurrent(id, signal); const f = j.files[i];
      update(id, { status: "uploading", phase: "上传" + ({ media: "录像", cover: "封面", subtitle: "字幕", metadata: "归档说明" }[f.role] || "附件"), files: job(id).files.map((x, n) => n === i ? { ...x, status: "uploading", error: "" } : x) });
      try {
        let lastProgress = 0;
        const result = await provider.invoke("upload", { localPath: f.localPath, remoteDir: remotePath, filename: f.name, size: f.size, sha1: f.sha1, expectedAccountId: j.accountId, remoteFileId: f.remote?.fileId || undefined }, { signal, remoteRoot: j.targetPath, onProgress: p => {
          assertCurrent(id, signal); if (p.phase === "verifying" || Date.now() - lastProgress > 2000) { lastProgress = Date.now(); update(id, { status: p.phase === "verifying" ? "verifying" : "uploading", phase: p.phase === "verifying" ? "校验远端文件" : "上传" + f.name }); }
        } });
        assertCurrent(id, signal);
        const remote = result?.remote;
        if (!result?.verified || String(result.accountId) !== j.accountId || !remote?.fileId || !/^\d+$/.test(String(remote.fileId)) || Number(remote.size) !== f.size || String(remote.sha1).toUpperCase() !== f.sha1 || !/^\d+$/.test(String(remote.parentId)) || remote.path !== remotePath + "/" + f.name) throw realProvider.failure("mismatch");
        completedBytes += f.size;
        update(id, { files: job(id).files.map((x, n) => n === i ? { ...x, status: "succeeded", error: "", remote: { fileId: String(remote.fileId), parentId: String(remote.parentId), size: f.size, sha1: f.sha1, path: remote.path }, verifiedAt: nowIso() } : x), uploadedBytes: completedBytes, progress: Math.floor(100 * completedBytes / job(id).totalBytes) });
      } catch (e) {
        if (["unauthorized", "account_mismatch", "cancelled", "source_changed", "network", "timeout"].includes(e.code) || f.role === "media") throw e;
        failedAttachments = true;
        update(id, { files: job(id).files.map((x, n) => n === i ? { ...x, status: "failed", error: realProvider.MESSAGES[e.code] || "附件上传或校验失败" } : x) });
      }
    }
    assertCurrent(id, signal);
    const outcome = update(id, { status: failedAttachments ? "partial" : "succeeded", phase: failedAttachments ? "录像已校验，部分附件失败" : "全部文件已校验，本地原件保留", error: failedAttachments ? "部分附件未完成，请重试" : "", verifiedAt: failedAttachments ? null : nowIso(), progress: failedAttachments ? Math.min(99, job(id).progress) : 100, nextRetryAt: null });
    const backupRec = manager.getRecording(j.recordingId);
    if (failedAttachments) require("../notify").event("backup_failed", { id, recordingId: j.recordingId, title: backupRec?.title, error: "部分附件未完成，请重试", phase: outcome.phase });
    else require("../notify").event("backup_done", { id, recordingId: j.recordingId, title: backupRec?.title, remotePath: j.remotePath });
  }
  async function pump() {
    if (running || stopped || corruption || [...sessions.values()].some(s => s.pending)) return running;
    running = (async () => {
      while (!stopped && !corruption) {
        const next = jobs.find(j => ["queued", "retry_wait", "waiting_credentials"].includes(j.status) && (!j.nextRetryAt || Date.parse(j.nextRetryAt) <= Date.now()));
        if (!next) break;
        if (!connection.authorized) { if (next.status !== "waiting_credentials") update(next.id, { status: "waiting_credentials", phase: "等待115扫码授权" }); break; }
        const controller = new AbortController(); current = { id: next.id, controller };
        leases.acquire(next.id, next.files.map(f => f.localPath));
        try { await execute(next.id, controller.signal); }
        catch (e) {
          const latest = job(next.id);
          if (latest?.status !== "cancelled") {
            const code = e.code || "provider_error";
            const retryable = ["network", "timeout"].includes(code) && (latest?.attempts || 0) < 4;
            const status = code === "cancelled" && stopped ? "queued" : code === "unauthorized" ? "waiting_credentials" : code === "source_changed" ? "stale_source" : retryable ? "retry_wait" : "failed";
            if (code === "unauthorized") connection = { ...connection, authorized: false, message: realProvider.MESSAGES.unauthorized };
            try { update(next.id, { status, phase: status === "retry_wait" ? "网络异常，等待重试" : "备份未完成", error: realProvider.MESSAGES[code] || "备份失败，请检查文件和磁盘后重试", nextRetryAt: retryable ? new Date(Date.now() + Math.min(600000, 15000 * 2 ** (latest.attempts || 1))).toISOString() : null }); }
            catch { corruption = "115备份状态无法写入磁盘，已暂停；未确认备份成功"; }
            if (status === "failed") require("../notify").event("backup_failed", { id: next.id, recordingId: next.recordingId, title: manager.getRecording(next.recordingId)?.title, error: realProvider.MESSAGES[code] || "备份失败，请检查文件和磁盘后重试" });
          }
        } finally { current = null; if (!ACTIVE.has(job(next.id)?.status)) leases.releaseOwner(next.id); }
        if (job(next.id)?.status === "waiting_credentials") break;
      }
    })();
    try { await running; } finally { running = null; }
  }
  function kick() { if (!stopped) setImmediate(() => void pump().catch(() => { corruption = "115备份队列无法安全保存，已暂停"; })); }
  function retry(id) {
    healthy(); const found = job(id); if (!found) throw fail("备份任务不存在", 404);
    if (ACTIVE.has(found.status)) return dto(found);
    if (["cancelled", "stale_source"].includes(found.status)) return enqueueOne(found.recordingId);
    if (found.status === "succeeded") return dto(found).status === "stale_source" ? enqueueOne(found.recordingId) : dto(found);
    if (!connection.authorized || found.accountId !== connection.accountId) throw fail("请连接原115账号，或取消旧任务后重新备份", 409);
    assertCurrent(id); leases.acquire(id, found.files.map(f => f.localPath));
    try { const next = update(id, { status: "queued", phase: "等待重试及远端对账", error: "", nextRetryAt: null, attempts: 0 }); kick(); return dto(next); } catch (e) { leases.releaseOwner(id); throw e; }
  }
  function cancel(id) {
    healthy(); const found = job(id); if (!found) throw fail("备份任务不存在", 404);
    if (!ACTIVE.has(found.status)) return dto(found);
    const next = update(id, { status: "cancelled", phase: "已取消；已上传的云端文件保留", error: "", nextRetryAt: null });
    if (current?.id === id) current.controller.abort(); else leases.releaseOwner(id);
    return dto(next);
  }
  function unchangedBackup(rec) {
    const id = String(rec.id), file = path.resolve(rec.filePath || ""), version = rec.archiveVersion || null;
    return jobs.some(j => {
      if (j.recordingId !== id || j.accountId !== connection.accountId || j.targetPath !== settings.targetPath || !j.source?.stat) return false;
      if (!ACTIVE.has(j.status) && !["succeeded", "partial", "cancelled"].includes(j.status)) return false;
      if (j.source.path !== file || (j.source.version || null) !== version) return false;
      try { const s = fs.statSync(j.source.path); return s.isFile() && s.size === j.source.stat.size && s.mtimeMs === j.source.stat.mtimeMs; } catch { return false; }
    });
  }
  function scan() {
    if (stopped || corruption) return;
    if (settings.autoBackup && settings.autoSince && connection.authorized) {
      let latest = 0;
      for (const rec of manager.getRecordings()) {
        const when = Date.parse(rec.archivedAt || rec.endedAt || rec.recordedAt);
        if (!(when >= Date.parse(settings.autoSince))) continue;
        try { if (!unchangedBackup(rec)) enqueueOne(String(rec.id), true); if (when > latest) latest = when; }
        catch (e) { console.warn("[backup115] 自动备份扫描入队失败 recordingId=" + rec.id + ": " + (e && e.message || e)); }
      }
      if (latest > Date.parse(settings.autoSince)) { try { const next = { ...settings, autoSince: new Date(latest).toISOString() }; write(settingsFile, next); settings = next; } catch (e) { console.warn("[backup115] 自动备份进度推进失败: " + (e && e.message || e)); } }
    }
    kick();
  }
  async function start() {
    if (!stopped) return; stopped = false;
    if (corruption) return;
    interval = setInterval(scan, 15000); interval.unref?.();
    await check(); scan();
  }
  async function stop() {
    stopped = true; clearInterval(interval); qrEpoch++; sessions.clear(); current?.controller.abort();
    await running;
  }
  return { status, saveSettings, check, qrStart, qrPoll, logout, enqueue, retry, cancel, start, stop, scan, pump,
    _internals: { getJobs: () => jobs, setConnection: v => { connection = normalizeConnection(v); }, enqueueOne, assertCurrent, execute, hashFile, dto, stateFile, settingsFile } };
}
let singleton;
function service() { return singleton ||= createService(); }
module.exports = { createService, ACTIVE, safeTarget, segment, inside, service };
