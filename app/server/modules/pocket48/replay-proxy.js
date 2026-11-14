"use strict";

const crypto = require("crypto");
const dns = require("dns");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");
const { isPrivateIp } = require("./stream-proxy");

const MAX_LIFETIME_MS = Math.min(
  6 * 60 * 60 * 1000,
  Math.max(30 * 60 * 1000, Number(process.env.REPLAY_SESSION_MAX_TTL_MS) || 6 * 60 * 60 * 1000)
);
const IDLE_TTL_MS = Math.min(
  MAX_LIFETIME_MS,
  Math.max(5 * 60 * 1000, Number(process.env.REPLAY_SESSION_IDLE_TTL_MS) || 30 * 60 * 1000)
);
const UNKNOWN_DURATION_TTL_MS = MAX_LIFETIME_MS;
const DURATION_BUFFER_MS = 30 * 60 * 1000;
const MAX_SESSIONS = Math.max(100, Number(process.env.REPLAY_SESSION_MAX) || 2000);
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_PREFIXES = 64;
const ALLOWED_HOSTS = String(process.env.POCKET48_REPLAY_HOSTS || "idol-vod.48.cn")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const TOKEN_KEY = crypto.createHash("sha256")
  .update(`${process.env.STREAM_TOKEN_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")}:pocket48-replay-v1`)
  .digest();

const sessions = new Map();
const replaySessions = new Map();

function decodedPathname(parsed) {
  let decoded = parsed.pathname;
  try {
    for (let count = 0; count < 3 && /%[0-9a-f]{2}/i.test(decoded); count += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error("Replay resource path is invalid");
  }
  decoded = decoded.replace(/\\/g, "/");
  if (decoded.includes("\0") || decoded.split("/").includes("..")) {
    throw new Error("Replay resource path traversal is forbidden");
  }
  return decoded;
}

function validateSourceUrl(rawUrl, scope, options = {}) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") throw new Error("Replay stream must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("Replay URL credentials are forbidden");
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(hostname)) throw new Error("Replay stream host is not allowlisted");
  const decodedPath = decodedPathname(parsed);
  if (scope) {
    const allowedPath = options.allowUnregistered === true ||
      Array.from(scope.resourcePathPrefixes || []).some((prefix) => decodedPath.startsWith(prefix));
    if (parsed.origin !== scope.origin || !allowedPath) {
      throw new Error("Replay resource is outside the session scope");
    }
  }
  parsed.hash = "";
  return parsed;
}

function scopeFor(parsed) {
  const slash = parsed.pathname.lastIndexOf("/");
  const pathPrefix = parsed.pathname.slice(0, slash + 1);
  const decodedPathPrefix = decodedPathname(new URL(pathPrefix, parsed));
  return {
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    pathPrefix,
    resourcePathPrefixes: new Set([decodedPathPrefix]),
  };
}

function isConfirmedHlsUrl(parsed) {
  const hint = `${parsed.pathname} ${parsed.searchParams.get("format") || ""} ${parsed.searchParams.get("type") || ""}`;
  return /(?:\.m3u8|\bhls\b)/i.test(hint);
}

function lifetimeFor(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return UNKNOWN_DURATION_TTL_MS;
  return Math.min(MAX_LIFETIME_MS, Math.max(IDLE_TTL_MS, durationSeconds * 1000 + DURATION_BUFFER_MS));
}

function pruneSessions(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.idleExpiresAt <= now || session.maxExpiresAt <= now) {
      sessions.delete(token);
      if (replaySessions.get(session.replayId) === token) replaySessions.delete(session.replayId);
    }
  }
  while (sessions.size >= MAX_SESSIONS) {
    const token = sessions.keys().next().value;
    const session = sessions.get(token);
    sessions.delete(token);
    if (session && replaySessions.get(session.replayId) === token) replaySessions.delete(session.replayId);
  }
}

function getOrCreate({ replayId, streamUrl, durationSeconds }) {
  const parsed = validateSourceUrl(streamUrl);
  if (!isConfirmedHlsUrl(parsed)) throw new Error("Replay stream format is unsupported");
  const id = String(replayId);
  const now = Date.now();
  pruneSessions(now);
  const existingToken = replaySessions.get(id);
  const existing = existingToken && sessions.get(existingToken);
  const scope = scopeFor(parsed);
  if (existing && existing.scope.origin === scope.origin && existing.scope.pathPrefix === scope.pathPrefix) {
    existing.rootUrl = parsed.toString();
    existing.idleExpiresAt = Math.min(existing.maxExpiresAt, now + IDLE_TTL_MS);
    return publicSession(existing);
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const maxExpiresAt = now + lifetimeFor(durationSeconds);
  const session = {
    token,
    replayId: id,
    rootUrl: parsed.toString(),
    scope,
    createdAt: now,
    maxExpiresAt,
    idleExpiresAt: Math.min(maxExpiresAt, now + IDLE_TTL_MS),
  };
  sessions.set(token, session);
  replaySessions.set(id, token);
  return publicSession(session);
}

function publicSession(session) {
  return {
    replayId: session.replayId,
    playUrl: `/api/public/replay-streams/${session.token}/manifest`,
    expiresAt: session.maxExpiresAt,
  };
}

function resolveSession(token) {
  const session = sessions.get(String(token));
  const now = Date.now();
  if (!session || session.idleExpiresAt <= now || session.maxExpiresAt <= now) {
    if (session) {
      sessions.delete(session.token);
      if (replaySessions.get(session.replayId) === session.token) replaySessions.delete(session.replayId);
    }
    return null;
  }
  session.idleExpiresAt = Math.min(session.maxExpiresAt, now + IDLE_TTL_MS);
  return session;
}

function sealChild(session, absoluteUrl) {
  const parsed = validateSourceUrl(absoluteUrl, session.scope);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", TOKEN_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify({ sid: session.token, url: parsed.toString(), exp: session.maxExpiresAt }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function decodeCanonicalBase64Url(token) {
  if (typeof token !== "string" || !token || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const decoded = Buffer.from(token, "base64url");
  return decoded.toString("base64url") === token ? decoded : null;
}

function openChild(session, token) {
  try {
    const packed = decodeCanonicalBase64Url(token);
    if (!packed || packed.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", TOKEN_KEY, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (payload.sid !== session.token || !Number.isFinite(payload.exp) || payload.exp !== session.maxExpiresAt || payload.exp <= Date.now()) return null;
    return validateSourceUrl(payload.url, session.scope).toString();
  } catch {
    return null;
  }
}

function childPath(session, rawUrl, baseUrl) {
  const absolute = new URL(rawUrl, baseUrl).toString();
  return `/api/public/replay-streams/${session.token}/resource/${sealChild(session, absolute)}`;
}

function manifestUris(text) {
  const uris = [];
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith("#")) uris.push(line.trim());
    for (const match of line.matchAll(/URI="([^"]+)"/g)) uris.push(match[1]);
  }
  return uris;
}

function authorizeManifestResources(text, baseUrl, session) {
  const additions = new Set();
  for (const raw of manifestUris(text)) {
    const parsed = validateSourceUrl(new URL(raw, baseUrl), session.scope, { allowUnregistered: true });
    const decodedPath = decodedPathname(parsed);
    const slash = decodedPath.lastIndexOf("/");
    const prefix = decodedPath.slice(0, slash + 1);
    if (!prefix || prefix === "/") throw new Error("Replay resource scope is too broad");
    if (!session.scope.resourcePathPrefixes.has(prefix)) additions.add(prefix);
  }
  if (session.scope.resourcePathPrefixes.size + additions.size > MAX_RESOURCE_PREFIXES) {
    throw new Error("Replay manifest has too many resource scopes");
  }
  for (const prefix of additions) session.scope.resourcePathPrefixes.add(prefix);
}

function rewriteManifest(text, baseUrl, session) {
  authorizeManifestResources(text, baseUrl, session);
  const rewrite = (raw) => childPath(session, raw, baseUrl);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return rewrite(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
    })
    .join("\n");
}

function decodeManifest(buffer, contentEncoding) {
  const encoding = String(contentEncoding || "identity").split(",", 1)[0].trim().toLowerCase();
  let decoded;
  if (!encoding || encoding === "identity") decoded = buffer;
  else if (encoding === "gzip" || encoding === "x-gzip") decoded = zlib.gunzipSync(buffer, { maxOutputLength: MANIFEST_MAX_BYTES });
  else if (encoding === "deflate") decoded = zlib.inflateSync(buffer, { maxOutputLength: MANIFEST_MAX_BYTES });
  else if (encoding === "br") decoded = zlib.brotliDecompressSync(buffer, { maxOutputLength: MANIFEST_MAX_BYTES });
  else throw new Error("Unsupported replay content encoding");
  if (decoded.length > MANIFEST_MAX_BYTES) throw new Error("Replay manifest too large");
  return decoded.toString("utf8");
}

function errorCode(error) {
  const message = String(error?.message || "");
  if (/too large/i.test(message)) return "MANIFEST_TOO_LARGE";
  if (/content encoding/i.test(message)) return "UNSUPPORTED_CONTENT_ENCODING";
  if (/outside the session scope|resource scope/i.test(message)) return "RESOURCE_SCOPE_REJECTED";
  if (/path traversal|path is invalid/i.test(message)) return "RESOURCE_PATH_REJECTED";
  if (/allowlisted|Private replay address|credentials|HTTPS/i.test(message)) return "SOURCE_REJECTED";
  if (/timeout/i.test(message)) return "UPSTREAM_TIMEOUT";
  if (/redirect/i.test(message)) return "UPSTREAM_REDIRECT_REJECTED";
  if (typeof error?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code)) return error.code;
  return "UNEXPECTED_ERROR";
}

function logReplayError(stage, error, details = {}) {
  const event = {
    event: "pocket48_replay_proxy_error",
    stage: String(stage || "unknown").slice(0, 64),
    code: errorCode(error),
  };
  if (Number.isInteger(details.upstreamStatus)) event.upstreamStatus = details.upstreamStatus;
  if (typeof details.host === "string" && ALLOWED_HOSTS.includes(details.host.toLowerCase())) event.upstreamHost = details.host.toLowerCase();
  const mimeType = typeof details.contentType === "string" ? details.contentType.split(";", 1)[0].trim().toLowerCase() : "";
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) {
    event.contentType = mimeType;
  }
  if (typeof details.contentEncoding === "string" && /^[a-z0-9_-]{1,20}$/i.test(details.contentEncoding)) {
    event.contentEncoding = details.contentEncoding;
  }
  console.error(JSON.stringify(event));
}

function safeLookup(hostname, options, callback) {
  const opts = typeof options === "object" ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((item) => !isPrivateIp(item.address));
    if (!allowed.length || allowed.length !== addresses.length) return callback(new Error("Private replay address is forbidden"));
    if (opts.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

function upstreamRequest(url, reqHeaders, session, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = validateSourceUrl(url, session.scope); } catch (err) { reject(err); return; }
    const headers = {
      Accept: reqHeaders.accept || "*/*",
      "Accept-Encoding": "identity",
      "User-Agent": "Mozilla/5.0 shn48-replay-proxy/1.0",
      Referer: "https://www.48.cn/",
    };
    if (reqHeaders.range) headers.Range = reqHeaders.range;
    const upstream = https.get(parsed, { headers, lookup: safeLookup }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 3) return reject(new Error("Too many replay redirects"));
        const redirectUrl = new URL(response.headers.location, parsed).toString();
        try { validateSourceUrl(redirectUrl, session.scope); } catch (err) { reject(err); return; }
        return upstreamRequest(redirectUrl, reqHeaders, session, redirects + 1).then(resolve, reject);
      }
      resolve({ response, finalUrl: parsed.toString() });
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Replay upstream timeout")));
    upstream.on("error", reject);
  });
}

function isHls(contentType, url) {
  return /mpegurl/i.test(contentType || "") || /\.m3u8(?:[?#]|$)/i.test(url);
}

async function proxyUrl(req, res, session, url, requestKind) {
  try {
    const { response, finalUrl } = await upstreamRequest(url, req.headers, session);
    const contentType = response.headers["content-type"] || "application/octet-stream";
    const contentEncoding = response.headers["content-encoding"] || "identity";
    const logDetails = {
      upstreamStatus: response.statusCode,
      host: new URL(finalUrl).hostname,
      contentType,
      contentEncoding,
    };
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      logReplayError(`${requestKind}_upstream_status`, new Error("Replay upstream returned an error status"), logDetails);
      return res.status(502).json({ success: false, error: "Replay stream is unavailable" });
    }
    if (isHls(contentType, finalUrl)) {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MANIFEST_MAX_BYTES) response.destroy(new Error("Replay manifest too large"));
        else chunks.push(chunk);
      });
      response.on("error", (error) => {
        logReplayError(`${requestKind}_manifest_read`, error, logDetails);
        if (!res.headersSent) res.status(502).json({ success: false, error: "Replay stream is unavailable" });
        else res.end();
      });
      response.on("end", () => {
        if (res.headersSent) return;
        let body;
        try {
          const manifest = decodeManifest(Buffer.concat(chunks), contentEncoding);
          if (!manifest.startsWith("#EXTM3U")) throw new Error("Replay manifest header is invalid");
          body = rewriteManifest(manifest, finalUrl, session);
        } catch (error) {
          logReplayError(`${requestKind}_manifest_rewrite`, error, logDetails);
          return res.status(502).json({ success: false, error: "Replay manifest is invalid" });
        }
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
  } catch (error) {
    logReplayError(`${requestKind}_request`, error, { host: session.scope.hostname });
    if (!res.headersSent) res.status(502).json({ success: false, error: "Replay stream is unavailable" });
    else res.end();
  }
}

function serveManifest(req, res) {
  const session = resolveSession(req.params.sessionToken);
  if (!session) return res.status(404).json({ success: false, error: "Replay session expired or invalid" });
  return proxyUrl(req, res, session, session.rootUrl, "root");
}

function serveResource(req, res) {
  const session = resolveSession(req.params.sessionToken);
  if (!session) return res.status(404).json({ success: false, error: "Replay session expired or invalid" });
  const url = openChild(session, req.params.childToken);
  if (!url) return res.status(404).json({ success: false, error: "Replay resource token expired or invalid" });
  return proxyUrl(req, res, session, url, "resource");
}

const cleanupTimer = setInterval(pruneSessions, 60_000);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

module.exports = {
  getOrCreate,
  serveManifest,
  serveResource,
  _internals: {
    sessions,
    replaySessions,
    validateSourceUrl,
    isConfirmedHlsUrl,
    scopeFor,
    lifetimeFor,
    resolveSession,
    sealChild,
    openChild,
    decodeCanonicalBase64Url,
    rewriteManifest,
    manifestUris,
    authorizeManifestResources,
    decodeManifest,
    errorCode,
    logReplayError,
    pruneSessions,
    ALLOWED_HOSTS,
    MAX_LIFETIME_MS,
    IDLE_TTL_MS,
    MANIFEST_MAX_BYTES,
    MAX_RESOURCE_PREFIXES,
    upstreamRequest,
  },
};
