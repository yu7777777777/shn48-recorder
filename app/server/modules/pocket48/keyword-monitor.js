"use strict";

// 口袋48消息关键词监控（"私人助理"）：轮询已配置房间的成员/粉丝消息，
// 命中关键词时推送到通知模块（feature #1 的外发通道）。消息读取复用
// account/api 既有链路；弹幕的 normalizeMessage 直接复用，两处格式一致。

const store = require("../../lib/store");
const api = require("./api");
const account = require("./account");
const { normalizeMessage } = require("./danmaku");

const SETTINGS_KEY = "keyword_monitor";
const LOG_LIMIT = 100;
const MAX_KEYWORDS = 30;
const MAX_ROOMS = 30;
const MAX_SEEN_PER_ROOM = 2000;
const MIN_POLL_SECONDS = 30;
const MAX_POLL_SECONDS = 1800;

const defaults = () => ({ enabled: false, keywords: [], rooms: [], pollSeconds: 60, cooldownMinutes: 30 });

let settings = load();
let timer = null;
let polling = false;
let lastError = null;
let lastRunAt = null;
// roomId -> Set(messageId)；(roomId,keyword) -> last notified ts
const seen = new Map();
const notified = new Map();
// 冷却时间戳跨重启持久化：否则服务重启后最近一轮命中的消息会被再次推送。
const STATE_KEY = "keyword_monitor_state";
let matches = store.load("keyword_monitor_log", []);
if (!Array.isArray(matches)) matches = [];
for (const [key, value] of Object.entries(store.load(STATE_KEY, {}) || {})) {
  if (typeof value === "number" && Number.isFinite(value)) notified.set(String(key), value);
}
let stateTimer = null;
let logTimer = null;

function load() {
  const saved = store.load(SETTINGS_KEY, {});
  const value = defaults();
  if (typeof saved.enabled === "boolean") value.enabled = saved.enabled;
  if (Array.isArray(saved.keywords)) {
    value.keywords = [...new Set(saved.keywords.map(row => String(row ?? "").trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
  }
  if (Array.isArray(saved.rooms)) {
    for (const row of saved.rooms.slice(0, MAX_ROOMS)) {
      const roomId = String(row?.roomId || "").trim();
      if (!/^\d{1,30}$/.test(roomId)) continue;
      value.rooms.push({ roomId, name: String(row?.name || "").slice(0, 60) });
    }
  }
  const pollSeconds = Number(saved.pollSeconds);
  if (Number.isInteger(pollSeconds) && pollSeconds >= MIN_POLL_SECONDS && pollSeconds <= MAX_POLL_SECONDS) value.pollSeconds = pollSeconds;
  const cooldown = Number(saved.cooldownMinutes);
  if (Number.isInteger(cooldown) && cooldown >= 0 && cooldown <= 1440) value.cooldownMinutes = cooldown;
  return value;
}

function persist() { store.save(SETTINGS_KEY, settings); }

function status() {
  return {
    ...settings,
    running: Boolean(timer),
    lastError,
    lastRunAt,
    matches: matches.slice(0, 50),
  };
}

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function recordMatch(entry) {
  matches.unshift(entry);
  if (matches.length > LOG_LIMIT) matches.length = LOG_LIMIT;
  if (!logTimer) {
    logTimer = setTimeout(() => { logTimer = null; store.save("keyword_monitor_log", matches); }, 2000);
    logTimer.unref?.();
  }
}

// One polling tick over every configured room. A room's failure only records
// lastError; other rooms keep going, and the next tick retries (token refresh,
// transient network). No backoff table: the load is one request per room per
// pollSeconds at minimum 30s. The 15s governor tick enforces pollSeconds, so a
// saved interval change applies without restarting the timer.
let lastPollTs = 0;
async function poll(force = false) {
  if (polling || !settings.enabled || !settings.rooms.length) return;
  if (!force && Date.now() - lastPollTs < settings.pollSeconds * 1000) return;
  polling = true;
  lastPollTs = Date.now();
  try {
    const keywords = settings.keywords.map(keyword => keyword.toLowerCase());
    for (const room of settings.rooms) {
      if (!settings.enabled) break;
      let rows;
      try {
        rows = account.messages(account.content(await api.getRoomMessages(room.roomId, 0, "all")));
        lastError = null;
      } catch (error) {
        lastError = clean(error?.message || "房间消息读取失败", 200);
        continue;
      }
      let seenIds = seen.get(room.roomId);
      if (!seenIds) { seenIds = new Set(); seen.set(room.roomId, seenIds); }
      for (const raw of rows) {
        const message = normalizeMessage(raw);
        if (!message || seenIds.has(message.id)) continue;
        seenIds.add(message.id);
        if (seenIds.size > MAX_SEEN_PER_ROOM) seenIds.delete(seenIds.values().next().value);
        const haystack = message.text.toLowerCase();
        const keyword = keywords.find(candidate => haystack.includes(candidate));
        if (!keyword) continue;
        const cooldownKey = `${room.roomId}:${keyword}`;
        const last = notified.get(cooldownKey) || 0;
        if (Date.now() - last < settings.cooldownMinutes * 60000) continue;
        notified.set(cooldownKey, Date.now());
        if (!stateTimer) {
          stateTimer = setTimeout(() => {
            stateTimer = null;
            store.save(STATE_KEY, Object.fromEntries(notified));
          }, 2000);
          stateTimer.unref?.();
        }
        const entry = {
          at: new Date().toISOString(),
          roomId: room.roomId,
          roomName: room.name || room.roomId,
          nickname: message.nickname,
          text: message.text,
          keyword,
        };
        recordMatch(entry);
        require("../notify").event("pocket48_keyword", entry);
      }
    }
    lastRunAt = new Date().toISOString();
  } finally {
    polling = false;
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void poll().catch(error => { lastError = clean(error?.message || "关键词监控轮询失败", 200); }), 15000);
  timer.unref?.();
  setTimeout(() => void poll().catch(() => {}), 15000).unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function save(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("关键词监控配置无效"), { statusCode: 400 });
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw Object.assign(new Error("监控开关必须为布尔值"), { statusCode: 400 });
    settings.enabled = input.enabled;
  }
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) throw Object.assign(new Error("关键词列表无效"), { statusCode: 400 });
    const keywords = [...new Set(input.keywords.map(row => String(row ?? "").trim()).filter(Boolean))];
    if (keywords.length > MAX_KEYWORDS) throw Object.assign(new Error(`最多 ${MAX_KEYWORDS} 个关键词`), { statusCode: 400 });
    if (keywords.some(keyword => keyword.length > 60)) throw Object.assign(new Error("单个关键词不能超过 60 字"), { statusCode: 400 });
    settings.keywords = keywords;
  }
  if (input.rooms !== undefined) {
    if (!Array.isArray(input.rooms)) throw Object.assign(new Error("监控房间列表无效"), { statusCode: 400 });
    const rooms = [];
    for (const row of input.rooms) {
      const roomId = account.roomId(row?.roomId);
      if (rooms.some(item => item.roomId === roomId)) continue;
      rooms.push({ roomId, name: clean(row?.name, 60) });
    }
    if (rooms.length > MAX_ROOMS) throw Object.assign(new Error(`最多监控 ${MAX_ROOMS} 个房间`), { statusCode: 400 });
    settings.rooms = rooms;
  }
  if (input.pollSeconds !== undefined) {
    const pollSeconds = Number(input.pollSeconds);
    if (!Number.isInteger(pollSeconds) || pollSeconds < MIN_POLL_SECONDS || pollSeconds > MAX_POLL_SECONDS) {
      throw Object.assign(new Error(`轮询间隔须为 ${MIN_POLL_SECONDS}-${MAX_POLL_SECONDS} 秒`), { statusCode: 400 });
    }
    settings.pollSeconds = pollSeconds;
  }
  if (input.cooldownMinutes !== undefined) {
    const cooldown = Number(input.cooldownMinutes);
    if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) throw Object.assign(new Error("通知冷却须为 0-1440 分钟"), { statusCode: 400 });
    settings.cooldownMinutes = cooldown;
  }
  persist();
  // Interval changes take effect on the next start; the poll cadence constant
  // reads settings each tick, so only restart when the interval itself changes.
  return status();
}

function clearLog() {
  matches = [];
  store.save("keyword_monitor_log", matches);
  return status();
}

module.exports = { status, save, start, stop, clearLog, poll, _internals: { load, defaults, matches: () => matches } };
