"use strict";

const store = require("../../lib/store");
const channels = require("./channels");
const LABELS = {
  recording_started: "开始录制", recording_done: "归档完成", recording_failed: "录制失败",
  upload_done: "B站投稿完成", upload_failed: "B站投稿失败", backup_done: "115备份完成", backup_failed: "115备份失败",
  analysis_done: "分析任务完成", analysis_failed: "分析任务失败", export_done: "转码导出完成", export_failed: "转码导出失败",
  pocket48_keyword: "口袋48关键词命中", failure_alert: "连续失败告警",
  update_available: "新版本可用",
};
const clone = value => JSON.parse(JSON.stringify(value));
const defaults = { enabled: false, channels: channels.DEFAULTS, events: Object.fromEntries(Object.keys(LABELS).map(key => [key, key !== "analysis_done"])), failures: { threshold: 3, cooldownMinutes: 60 } };
let cached, counters = {}, pending = 0;
function settings() {
  if (cached) return cached;
  const saved = store.load("notify_settings", {});
  cached = clone(defaults);
  cached.enabled = saved.enabled === true;
  for (const name of Object.keys(channels.DEFAULTS)) Object.assign(cached.channels[name], saved.channels?.[name]);
  for (const name of Object.keys(LABELS)) if (typeof saved.events?.[name] === "boolean") cached.events[name] = saved.events[name];
  Object.assign(cached.failures, saved.failures);
  return cached;
}
function publicSettings() {
  const result = clone(settings());
  for (const [name, fields] of Object.entries(channels.SECRETS)) for (const field of fields) {
    result.channels[name][`${field}Set`] = Boolean(result.channels[name][field]);
    delete result.channels[name][field];
  }
  return result;
}
function save(patch = {}) {
  const next = clone(settings());
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("总开关无效");
    next.enabled = patch.enabled;
  }
  for (const [key, value] of Object.entries(patch.events || {})) {
    if (!(key in LABELS) || typeof value !== "boolean") throw new Error("事件开关无效");
    next.events[key] = value;
  }
  for (const [name, value] of Object.entries(patch.channels || {})) {
    if (!Object.hasOwn(channels.DEFAULTS, name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("通道配置无效");
    const config = next.channels[name];
    for (const field of Object.keys(channels.DEFAULTS[name]).concat(name === "email" ? ["secure"] : [])) {
      if (value[field] === undefined) continue;
      if (channels.SECRETS[name].includes(field) && value[field] === "") continue;
      if (["enabled", "secure"].includes(field)) {
        if (typeof value[field] !== "boolean") throw new Error("通道开关无效");
        config[field] = value[field];
      } else if (field === "port") config[field] = Number(value[field]);
      else {
        if (typeof value[field] !== "string" || value[field].length > 4096) throw new Error("通道配置字段无效");
        config[field] = value[field].trim();
      }
    }
    for (const field of Array.isArray(value.clear) ? value.clear : []) if (channels.SECRETS[name].includes(field)) config[field] = "";
    channels.validate(name, config);
  }
  if (patch.failures) {
    const threshold = Number(patch.failures.threshold ?? next.failures.threshold);
    const cooldownMinutes = Number(patch.failures.cooldownMinutes ?? next.failures.cooldownMinutes);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50) throw new Error("连续失败阈值必须为 1-50");
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440) throw new Error("告警冷却时间必须为 1-1440 分钟");
    next.failures = { threshold, cooldownMinutes };
  }
  store.atomicWrite(store.filePath("notify_settings"), next);
  cached = next;
  return publicSettings();
}
function deliveryLog() { const log = store.load("notify_log", []); return Array.isArray(log) ? log.slice(0, 200) : []; }
function logDelivery(entry) {
  try { store.atomicWrite(store.filePath("notify_log"), [{ at: new Date().toISOString(), ...entry }, ...deliveryLog()].slice(0, 200)); } catch { /* A failed notification must never interrupt recording. */ }
}
function payloadFor(name, payload) {
  const parts = [payload.memberName, payload.title, payload.keyword ? `关键词：${payload.keyword}` : "", payload.text || payload.content, payload.error, payload.detail].filter(Boolean).map(value => String(value).slice(0, 2000));
  return { event: name, title: `48tools · ${LABELS[name] || "测试通知"}`, text: parts.join("\n").slice(0, 6000) || "48tools 通知服务正常", recordingId: String(payload.recordingId || payload.id || ""), at: new Date().toISOString() };
}
async function deliver(name, config, payload) {
  if (pending >= 100) { logDelivery({ channel: name, event: payload.event, ok: false, error: "通知队列已满" }); return; }
  pending++;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await channels.send(name, config, payload);
        logDelivery({ channel: name, event: payload.event, title: payload.title, ok: true });
        return;
      } catch {
        if (attempt === 0) await new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref?.(); });
      }
    }
    logDelivery({ channel: name, event: payload.event, title: payload.title, ok: false, error: "推送失败，请检查通道配置与网络" });
  } finally { pending--; }
}
function dispatch(name, payload, config) {
  if (!config.enabled || !config.events[name]) return;
  const message = payloadFor(name, payload);
  for (const [channel, value] of Object.entries(config.channels)) if (value.enabled) void deliver(channel, clone(value), message).catch(() => {});
}
function event(name, payload = {}) {
  try {
    const config = settings();
    if (!config.enabled || !Object.hasOwn(LABELS, name)) return;
    const domain = /^(recording|upload|backup|analysis|export)_(failed|done)$/.exec(name);
    if (domain) {
      const item = counters[domain[1]] ||= { count: 0, lastAlert: 0 };
      if (domain[2] === "done") item.count = 0;
      else {
        item.count++;
        if (item.count >= config.failures.threshold && Date.now() - item.lastAlert >= config.failures.cooldownMinutes * 60000) {
          item.lastAlert = Date.now();
          dispatch("failure_alert", { ...payload, detail: `${item.count} 次连续失败（${LABELS[name]}）` }, config);
        }
      }
    }
    dispatch(name, payload, config);
  } catch { /* Deliberately isolated from recording, backup and upload callers. */ }
}
async function test(channel) {
  const config = settings().channels[channel];
  if (!config) throw new Error("通道配置无效");
  channels.requireReady(channel, config);
  try {
    await channels.send(channel, clone(config), payloadFor("test", { text: "这是一条 48tools 测试通知" }));
    logDelivery({ channel, event: "test", ok: true });
    return { sent: true };
  } catch {
    logDelivery({ channel, event: "test", ok: false, error: "测试推送失败，请检查通道配置与网络" });
    throw new Error("测试推送失败，请检查通道配置与网络");
  }
}
module.exports = { publicSettings, save, event, test, deliveryLog, _internals: { resetCounters() { counters = {}; } } };
