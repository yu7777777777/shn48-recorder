"use strict";

const crypto = require("crypto");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const { URL } = require("url");

const TOKEN_TTL_MS = Math.max(30_000, Number(process.env.STREAM_TOKEN_TTL_MS) || 5 * 60 * 1000);
const MAX_TOKENS = Math.max(1000, Number(process.env.STREAM_TOKEN_MAX) || 20_000);
const tokens = new Map();

function isPrivateIp(address) {
  if (!net.isIP(address)) return true;
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || octets[0] === 0;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb");
}

function validateUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported stream protocol");
  if (parsed.username || parsed.password) throw new Error("Stream URL credentials are forbidden");
  if (!parsed.hostname || parsed.hostname.toLowerCase() === "localhost") throw new Error("Invalid stream host");
  if (net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) throw new Error("Private stream address is forbidden");
  const allowlist = String(process.env.POCKET48_STREAM_HOSTS || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length && !allowlist.some((host) => parsed.hostname.toLowerCase() === host || parsed.hostname.toLowerCase().endsWith(`.${host}`))) {
    throw new Error("Stream host is not allowlisted");
  }
  return parsed;
}

function createToken(url, ttlMs = TOKEN_TTL_MS) {
  const parsed = validateUrl(url);
  if (tokens.size >= MAX_TOKENS) {
    const now = Date.now();
    for (const [existingToken, entry] of tokens) {
      if (entry.expiresAt <= now) tokens.delete(existingToken);
    }
    while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + ttlMs;
  tokens.set(token, { url: parsed.toString(), expiresAt });
  return { token, expiresAt };
}

function resolveToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  // Sliding expiry keeps an active HLS session alive while abandoned tokens remain short-lived.
  entry.expiresAt = Date.now() + TOKEN_TTL_MS;
  return entry;
}

function safeLookup(hostname, options, callback) {
  const opts = typeof options === "object" ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((item) => !isPrivateIp(item.address));
    if (!allowed.length || allowed.length !== addresses.length) return callback(new Error("Private stream address is forbidden"));
    if (opts.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

function upstreamRequest(url, reqHeaders, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = validateUrl(url); } catch (err) { reject(err); return; }
    const lib = parsed.protocol === "https:" ? https : http;
    const headers = {
      Accept: reqHeaders.accept || "*/*",
      "User-Agent": "Mozilla/5.0 shn48-live-proxy/1.0",
    };
    if (reqHeaders.range) headers.Range = reqHeaders.range;
    const upstream = lib.get(parsed, { headers, lookup: safeLookup }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new Error("Too many stream redirects"));
        const redirectUrl = new URL(response.headers.location, parsed).toString();
        return upstreamRequest(redirectUrl, reqHeaders, redirects + 1).then(resolve, reject);
      }
      resolve({ response, finalUrl: parsed.toString() });
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Stream upstream timeout")));
    upstream.on("error", reject);
  });
}

function isHls(contentType, url) {
  return /mpegurl/i.test(contentType || "") || /\.m3u8(?:[?#]|$)/i.test(url);
}

function rewriteManifest(text, baseUrl) {
  const rewrite = (raw) => {
    const absolute = new URL(raw, baseUrl).toString();
    const { token } = createToken(absolute);
    return `/api/public/streams/${token}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return rewrite(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
    })
    .join("\n");
}

async function proxyToken(req, res) {
  const entry = resolveToken(req.params.token);
  if (!entry) return res.status(404).json({ success: false, error: "Stream token expired or invalid" });
  try {
    const { response, finalUrl } = await upstreamRequest(entry.url, req.headers);
    const contentType = response.headers["content-type"] || "application/octet-stream";
    if (isHls(contentType, finalUrl)) {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response.destroy(new Error("HLS manifest too large"));
        else chunks.push(chunk);
      });
      response.on("error", (err) => {
        if (!res.headersSent) res.status(502).json({ success: false, error: err.message });
        else res.end();
      });
      response.on("end", () => {
        if (res.headersSent) return;
        const body = rewriteManifest(Buffer.concat(chunks).toString("utf8"), finalUrl);
        res.status(response.statusCode || 200);
        res.set({ "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
        res.send(body);
      });
      return;
    }
    res.status(response.statusCode || 200);
    res.set({
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Accept-Ranges": response.headers["accept-ranges"] || "bytes",
      ...(response.headers["content-range"] ? { "Content-Range": response.headers["content-range"] } : {}),
      ...(response.headers["content-length"] ? { "Content-Length": response.headers["content-length"] } : {}),
    });
    response.pipe(res);
    res.on("close", () => response.destroy());
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ success: false, error: "Stream unavailable" });
    else res.end();
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
}, 60_000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

module.exports = {
  isPrivateIp,
  createToken,
  resolveToken,
  proxyToken,
  TOKEN_TTL_MS,
  _internals: {
    validateUrl,
    isPrivateIp,
    rewriteManifest,
    tokens,
    MAX_TOKENS,
  },
};
