"use strict";

// Update checker: periodically compares the released VERSION in the GitHub
// repository against the running version and pushes a notification through the
// existing notify module when a newer release is found. The checker only ever
// READS from GitHub (Contents:read token) and never deploys anything by
// itself — applying an update stays a deliberate server-side action. Every
// failure is recorded in state and swallowed: a broken check must never
// affect recording, backup or upload.

const store = require("../../lib/store");
const { version } = require("../../lib/version");
const notify = require("../notify");

const defaults = { enabled: false, repo: "yu7777777777/shn48-recorder", branch: "main", intervalHours: 6, token: "" };
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BRANCH_RE = /^[\w./-]{1,100}$/;
const TOKEN_MAX = 512;
let cached, timer = null, initialTimer = null, checking = false;

function settings() {
  if (cached) return cached;
  const saved = store.load("update_checker_settings", {});
  const next = { ...defaults };
  if (typeof saved.enabled === "boolean") next.enabled = saved.enabled;
  if (typeof saved.repo === "string" && REPO_RE.test(saved.repo.trim())) next.repo = saved.repo.trim();
  if (typeof saved.branch === "string" && BRANCH_RE.test(saved.branch.trim())) next.branch = saved.branch.trim();
  if (Number.isInteger(saved.intervalHours) && saved.intervalHours >= 1 && saved.intervalHours <= 168) next.intervalHours = saved.intervalHours;
  if (typeof saved.token === "string" && saved.token) next.token = saved.token;
  return next;
}

function publicSettings() {
  const result = { ...settings(), token: undefined };
  result.tokenSet = Boolean(settings().token);
  delete result.token;
  return result;
}

// Reloads from disk; used by tests and after external state edits.
function _reset() { cached = null; }

function save(patch = {}) {
  const next = { ...settings() };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("定时开关无效");
    next.enabled = patch.enabled;
  }
  if (patch.repo !== undefined) {
    if (typeof patch.repo !== "string" || !REPO_RE.test(patch.repo.trim())) throw new Error("仓库格式无效，应为 owner/name");
    next.repo = patch.repo.trim();
  }
  if (patch.branch !== undefined) {
    if (typeof patch.branch !== "string" || !BRANCH_RE.test(patch.branch.trim())) throw new Error("分支名无效");
    next.branch = patch.branch.trim();
  }
  if (patch.intervalHours !== undefined) {
    const value = Number(patch.intervalHours);
    if (!Number.isInteger(value) || value < 1 || value > 168) throw new Error("检测间隔必须为 1-168 小时");
    next.intervalHours = value;
  }
  if (patch.token !== undefined && patch.token !== "") {
    if (typeof patch.token !== "string" || patch.token.length > TOKEN_MAX || /\s/.test(patch.token)) throw new Error("Token 格式无效");
    next.token = patch.token.trim();
  }
  for (const field of Array.isArray(patch.clear) ? patch.clear : []) if (field === "token") next.token = "";
  store.atomicWrite(store.filePath("update_checker_settings"), next);
  cached = next;
  return publicSettings();
}

function state() {
  const saved = store.load("update_checker_state", {});
  return {
    lastCheckAt: saved.lastCheckAt || null,
    remoteVersion: saved.remoteVersion || null,
    localVersion: saved.localVersion || null,
    upToDate: typeof saved.upToDate === "boolean" ? saved.upToDate : null,
    lastError: saved.lastError || null,
    lastNotifiedVersion: saved.lastNotifiedVersion || null,
  };
}

function recordState(patch) {
  const next = { ...state(), ...patch };
  store.atomicWrite(store.filePath("update_checker_state"), next);
  return next;
}

// Compares dotted release versions (1.32.4). Non-numeric segments fall back to
// 0 so a malformed remote value can never look "greater" by accident.
function greater(remote, local) {
  const parse = value => String(value || "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function fetchRemoteVersion(config) {
  const url = `https://api.github.com/repos/${config.repo}/contents/app/VERSION?ref=${encodeURIComponent(config.branch)}`;
  const headers = {
    "User-Agent": "48tools-update-checker",
    Accept: "application/vnd.github.raw",
  };
  // Token is optional: public repositories work anonymously (60 req/h per IP,
  // far above the default schedule); a token only lifts private repositories
  // into reach and raises the rate ceiling.
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("GitHub Token 无效或缺少该仓库的只读权限（公开仓库可清空 Token 走匿名）");
  if (res.status === 404) throw new Error("仓库、分支或 app/VERSION 不存在；私有仓库需要配置 Contents:read 的只读 PAT");
  if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
  const text = (await res.text()).trim();
  if (!/^\d+\.\d+\.\d+$/.test(text)) throw new Error(`仓库 VERSION 内容异常：${text.slice(0, 40)}`);
  return text;
}

// Runs one check. Manual calls surface the error; scheduled calls record it in
// state and swallow so the checker can never crash the process.
async function checkNow() {
  if (checking) return { skipped: true, reason: "已有检测在进行中" };
  checking = true;
  try {
    const config = settings();
    const remote = await fetchRemoteVersion(config);
    const local = version();
    const upToDate = !greater(remote, local);
    const next = recordState({ lastCheckAt: new Date().toISOString(), remoteVersion: remote, localVersion: local, upToDate, lastError: null });
    let notified = false;
    // One notification per released version: re-checks and restarts must not
    // re-send the same ping, but a newer version always does.
    if (!upToDate && remote !== next.lastNotifiedVersion) {
      notify.event("update_available", {
        title: `发现新版本 ${remote}`,
        text: `GitHub 仓库已发布 ${remote}，当前运行 ${local}。确认无误后在服务器执行更新脚本即可完成部署。`,
      });
      recordState({ lastNotifiedVersion: remote });
      notified = true;
    }
    return { localVersion: local, remoteVersion: remote, upToDate, notified };
  } catch (error) {
    recordState({ lastError: String(error?.message || error).slice(0, 300) });
    throw error;
  } finally {
    checking = false;
  }
}

function stop() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = initialTimer = null;
}

// Called from server startup; a disabled checker leaves no timers behind, and
// a schedule changed on the settings page is picked up on the next start().
function start() {
  stop();
  if (!settings().enabled) return;
  const tick = () => checkNow().catch(() => {});
  timer = setInterval(() => {
    if (!settings().enabled) return stop();
    tick();
  }, settings().intervalHours * 3600000);
  timer.unref?.();
  // First check shortly after boot so a released-but-undeployed version is
  // reported without waiting a full interval.
  initialTimer = setTimeout(tick, 20000);
  initialTimer.unref?.();
}

module.exports = { publicSettings, save, state, checkNow, start, stop, greater, _internals: { _reset } };
