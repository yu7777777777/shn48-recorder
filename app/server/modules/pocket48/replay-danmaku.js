"use strict";

const dns = require("dns");
const https = require("https");
const { URL } = require("url");
const { isPrivateIp } = require("./stream-proxy");

const MAX_FILE_BYTES = Math.max(256 * 1024, Number(process.env.REPLAY_DANMAKU_MAX_BYTES) || 8 * 1024 * 1024);
const MAX_MESSAGES = Math.max(1000, Number(process.env.REPLAY_DANMAKU_MAX_MESSAGES) || 30_000);
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.REPLAY_DANMAKU_CACHE_TTL_MS) || 30 * 60 * 1000);
const CACHE_MAX = Math.max(20, Number(process.env.REPLAY_DANMAKU_CACHE_MAX) || 200);
const ALLOWED_HOSTS = new Set(
  String(process.env.POCKET48_DANMAKU_HOSTS || "source.48.cn,source3.48.cn")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
const cache = new Map();

function clean(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validateDanmakuUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ""));
  if (parsed.protocol !== "https:") throw new Error("Replay danmaku must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Replay danmaku credentials are forbidden");
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("Replay danmaku host is not allowlisted");
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { throw new Error("Replay danmaku path is invalid"); }
  pathname = pathname.replace(/\\/g, "/");
  if (pathname.includes("\0") || pathname.split("/").includes("..")) throw new Error("Replay danmaku path traversal is forbidden");
  if (!pathname.startsWith("/live/lrc/") || !/\.lrc$/i.test(pathname)) throw new Error("Replay danmaku path is invalid");
  parsed.hash = "";
  return parsed;
}

function safeLookup(hostname, options, callback) {
  const opts = typeof options === "object" ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const allowed = addresses.filter((item) => !isPrivateIp(item.address));
    if (!allowed.length || allowed.length !== addresses.length) return callback(new Error("Private replay danmaku address is forbidden"));
    if (opts.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

function parseTimestamp(hours, minutes, seconds, fraction = "") {
  const milliseconds = Number(String(fraction).padEnd(3, "0").slice(0, 3) || 0);
  return ((Number(hours) * 60 * 60 + Number(minutes) * 60 + Number(seconds)) * 1000) + milliseconds;
}

function parseLrc(text) {
  const messages = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length && messages.length < MAX_MESSAGES; lineIndex += 1) {
    const match = lines[lineIndex].match(/^\[(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?\](.*)$/);
    if (!match) continue;
    const separator = match[5].indexOf("\t");
    if (separator < 0) continue;
    const nickname = clean(match[5].slice(0, separator), 32) || "观众";
    const messageText = clean(match[5].slice(separator + 1), 160);
    if (!messageText) continue;
    const atMs = parseTimestamp(match[1], match[2], match[3], match[4]);
    messages.push({ id: `${atMs}:${lineIndex}`, atMs, nickname, text: messageText });
  }
  messages.sort((left, right) => left.atMs - right.atMs);
  return messages;
}

function requestText(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = validateDanmakuUrl(rawUrl); } catch (error) { reject(error); return; }
    const request = https.get(parsed, {
      headers: {
        Accept: "text/plain,*/*;q=0.5",
        "Accept-Encoding": "identity",
        "User-Agent": "Mozilla/5.0 shn48-replay-danmaku/1.0",
        Referer: "https://www.48.cn/",
      },
      lookup: safeLookup,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new Error("Too many replay danmaku redirects"));
        const target = new URL(response.headers.location, parsed).toString();
        try { validateDanmakuUrl(target); } catch (error) { reject(error); return; }
        requestText(target, redirects + 1).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error("Replay danmaku upstream returned an error status"));
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES) response.destroy(new Error("Replay danmaku file too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.setTimeout(20_000, () => request.destroy(new Error("Replay danmaku upstream timeout")));
    request.on("error", reject);
  });
}

function cached(replayId, url) {
  const entry = cache.get(String(replayId));
  if (!entry || entry.url !== url || entry.expiresAt <= Date.now()) {
    if (entry) cache.delete(String(replayId));
    return null;
  }
  cache.delete(String(replayId));
  cache.set(String(replayId), entry);
  return entry.messages;
}

async function load(replayId, url) {
  if (!url) {
    const error = new Error("Replay danmaku is unavailable");
    error.statusCode = 404;
    throw error;
  }
  const validated = validateDanmakuUrl(url).toString();
  const existing = cached(replayId, validated);
  if (existing) return existing;
  const messages = parseLrc(await requestText(validated));
  cache.set(String(replayId), { url: validated, messages, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return messages;
}

module.exports = {
  load,
  parseLrc,
  validateDanmakuUrl,
  _internals: { cache, parseTimestamp, clean, ALLOWED_HOSTS, MAX_FILE_BYTES, MAX_MESSAGES },
};
