"use strict";

const smtp = require("./smtp");
const SECRETS = { telegram: ["botToken"], email: ["pass"], serverchan: ["sendKey"], bark: ["deviceKey"], webhook: ["secret"] };
const DEFAULTS = {
  telegram: { enabled: false, botToken: "", chatId: "" },
  email: { enabled: false, host: "", port: 465, user: "", pass: "", from: "", to: "" },
  serverchan: { enabled: false, sendKey: "" },
  bark: { enabled: false, server: "https://api.day.app", deviceKey: "" },
  webhook: { enabled: false, url: "", secret: "" },
};
function assertHttpUrl(value, label) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${label}必须是 http/https 地址`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label}必须是 http/https 地址`);
  if (url.username || url.password) throw new Error(`${label}不能包含账号密码`);
  return url.toString().replace(/\/+$/, "");
}
function validate(name, config) {
  if (name === "telegram" && config.botToken && !/^\d+:[A-Za-z0-9_-]{15,}$/.test(config.botToken)) throw new Error("Telegram Bot Token 格式无效");
  if (name === "telegram" && /[\r\n]/.test(config.chatId)) throw new Error("chat ID 无效");
  if (name === "email") {
    if (config.host) smtp._internals.normalizeHost(config.host);
    if (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("SMTP 端口必须为 1-65535");
    for (const field of ["from", "to"]) if (config[field]) smtp._internals.address(config[field]);
    if (/[\r\n]/.test(config.user)) throw new Error("SMTP 账号无效");
  }
  if (name === "serverchan" && config.sendKey && !/^[A-Za-z0-9_-]+$/.test(config.sendKey)) throw new Error("SendKey 格式无效");
  if (name === "bark") {
    config.server = assertHttpUrl(config.server || "https://api.day.app", "Bark 服务器");
    if (config.deviceKey && !/^[A-Za-z0-9_-]+$/.test(config.deviceKey)) throw new Error("deviceKey 格式无效");
  }
  if (name === "webhook" && config.url) config.url = assertHttpUrl(config.url, "Webhook 地址");
  return config;
}
function requireReady(name, config) {
  const required = { telegram: [["botToken", "Bot Token"], ["chatId", "chat ID"]], email: [["host", "SMTP 服务器"], ["to", "收件人"]], serverchan: [["sendKey", "SendKey"]], bark: [["deviceKey", "deviceKey"]], webhook: [["url", "Webhook 地址"]] };
  if (!required[name]) throw new Error("通道配置无效");
  for (const [field, label] of required[name]) if (!config[field]) throw new Error(`缺少${label}`);
  if (name === "email" && !config.from && !config.user) throw new Error("缺少发件人");
  validate(name, { ...config });
}
async function request(url, body, headers = {}) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error(`推送服务返回 HTTP ${response.status}`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return {}; }
}
async function send(name, config, payload) {
  requireReady(name, config);
  let result;
  if (name === "email") return smtp.send(config, payload);
  if (name === "telegram") {
    result = await request(`https://api.telegram.org/bot${config.botToken}/sendMessage`, { chat_id: config.chatId, text: `${payload.title}\n${payload.text}`.slice(0, 4096) });
    if (result.ok === false) throw new Error("Telegram 拒绝推送，请检查 Bot Token 与 chat ID");
  } else if (name === "serverchan") {
    result = await request(`https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`, { title: payload.title.slice(0, 100), desp: payload.text });
    if (result.code !== undefined && Number(result.code) !== 0) throw new Error("Server酱拒绝推送，请检查 SendKey");
  } else if (name === "bark") {
    result = await request(`${assertHttpUrl(config.server, "Bark 服务器")}/push`, { device_key: config.deviceKey, title: payload.title, body: payload.text, group: "48tools" });
    if (result.code !== undefined && Number(result.code) !== 200) throw new Error("Bark 拒绝推送，请检查 deviceKey");
  } else {
    await request(assertHttpUrl(config.url, "Webhook 地址"), payload, config.secret ? { Authorization: `Bearer ${config.secret}` } : {});
  }
}
module.exports = { send, validate, requireReady, DEFAULTS, SECRETS, _internals: { assertHttpUrl } };
