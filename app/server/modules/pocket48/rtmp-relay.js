"use strict";

const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { isPrivateIp } = require("./stream-proxy");

function relayFfmpegArgs(streamUrl, directory) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-rw_timeout", "15000000",
    "-i", streamUrl,
    "-map", "0:v?", "-map", "0:a?",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "6",
    "-hls_delete_threshold", "2",
    "-hls_flags", "delete_segments+omit_endlist+independent_segments",
    "-hls_segment_filename", path.join(directory, "segment_%06d.ts"),
    path.join(directory, "index.m3u8"),
  ];
}

function createRelayManager(options = {}) {
  const fsApi = options.fs || fs;
  const spawnImpl = options.spawn || spawn;
  const lookup = options.lookup || dns.lookup;
  const baseDir = path.resolve(options.baseDir || process.env.STREAM_RELAY_DIR || path.join(os.tmpdir(), "shn48-relays"));
  const startupTimeoutMs = Math.max(1000, Number(options.startupTimeoutMs || process.env.RTMP_RELAY_STARTUP_MS) || 10_000);
  const idleTimeoutMs = Math.max(10_000, Number(options.idleTimeoutMs || process.env.RTMP_RELAY_IDLE_MS) || 90_000);
  const maxRelays = Math.max(1, Number(options.maxRelays || process.env.RTMP_RELAY_MAX) || 20);
  const pollMs = Math.max(10, Number(options.pollMs) || 100);
  const relaysByLiveId = new Map();
  const relaysByToken = new Map();
  const starts = new Map();
  let closing = false;
  fsApi.mkdirSync(baseDir, { recursive: true });

  function allowedHosts() {
    return String(process.env.POCKET48_RTMP_HOSTS || process.env.POCKET48_STREAM_HOSTS || "")
      .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  }

  function validateRtmpUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "rtmp:") throw new Error("RTMP stream required");
    if (parsed.username || parsed.password) throw new Error("Stream URL credentials are forbidden");
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost") throw new Error("Invalid stream host");
    if (net.isIP(hostname) && isPrivateIp(hostname)) throw new Error("Private stream address is forbidden");
    const allowlist = allowedHosts();
    const allowed = allowlist.length
      ? allowlist.some((host) => hostname === host || hostname.endsWith(`.${host}`))
      : hostname === "48.cn" || hostname.endsWith(".48.cn");
    if (!allowed) throw new Error("RTMP stream host is not allowlisted");
    return parsed;
  }

  function assertPublicHostname(hostname) {
    return new Promise((resolve, reject) => {
      lookup(hostname, { all: true }, (err, addresses) => {
        if (err) return reject(err);
        if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
          return reject(new Error("Private stream address is forbidden"));
        }
        resolve();
      });
    });
  }

  function safeRelayDir(id) {
    const directory = path.resolve(baseDir, id);
    if (path.dirname(directory) !== baseDir) throw new Error("Invalid relay directory");
    return directory;
  }

  function removeRelay(relay) {
    if (relay.cleaned) return;
    relay.cleaned = true;
    if (relaysByLiveId.get(relay.liveId) === relay) relaysByLiveId.delete(relay.liveId);
    if (relaysByToken.get(relay.token) === relay) relaysByToken.delete(relay.token);
    try { fsApi.rmSync(relay.directory, { recursive: true, force: true }); } catch {}
  }

  function waitUntilReady(relay) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + startupTimeoutMs;
      const check = () => {
        if (["failed", "ended", "stopping"].includes(relay.status)) {
          return reject(new Error("RTMP relay ended before HLS became ready"));
        }
        try {
          const manifest = fsApi.readFileSync(relay.manifestPath, "utf8");
          if (manifest.includes("#EXTM3U")) return resolve();
        } catch {}
        if (Date.now() >= deadline) return reject(new Error("RTMP relay startup timed out"));
        relay.readyTimer = setTimeout(check, pollMs);
      };
      check();
    });
  }

  async function startRelay(liveId, streamUrl) {
    if (closing) throw new Error("RTMP relay manager is shutting down");
    const parsed = validateRtmpUrl(streamUrl);
    await assertPublicHostname(parsed.hostname);
    if (closing) throw new Error("RTMP relay manager is shutting down");
    if (relaysByLiveId.size >= maxRelays) throw new Error("RTMP relay capacity reached");
    const id = `relay_${crypto.randomBytes(12).toString("hex")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const directory = safeRelayDir(id);
    fsApi.mkdirSync(directory, { recursive: true });
    let child;
    try {
      child = spawnImpl(process.env.FFMPEG_BIN || "ffmpeg", relayFfmpegArgs(parsed.toString(), directory), {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      try { fsApi.rmSync(directory, { recursive: true, force: true }); } catch {}
      throw err;
    }
    const relay = {
      id,
      token,
      liveId,
      directory,
      manifestPath: path.join(directory, "index.m3u8"),
      child,
      status: "starting",
      startedAt: new Date().toISOString(),
      lastAccess: Date.now(),
      cleaned: false,
      readyTimer: null,
    };
    relaysByLiveId.set(liveId, relay);
    relaysByToken.set(token, relay);
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      relay.status = "failed";
      removeRelay(relay);
    });
    child.once("close", () => {
      relay.status = "ended";
      removeRelay(relay);
    });
    try {
      await waitUntilReady(relay);
      if (relay.cleaned || relay.status !== "starting") throw new Error("RTMP relay ended before HLS became ready");
      relay.status = "running";
      relay.lastAccess = Date.now();
      return publicRelay(relay);
    } catch (err) {
      try { child.kill("SIGTERM"); } catch {}
      removeRelay(relay);
      throw err;
    }
  }

  function publicRelay(relay) {
    return {
      token: relay.token,
      liveId: relay.liveId,
      playUrl: `/api/public/relays/${relay.token}/index.m3u8`,
      startedAt: relay.startedAt,
    };
  }

  function getOrStart({ liveId, streamUrl }) {
    const key = String(liveId || "");
    if (!key) return Promise.reject(new Error("liveId is required"));
    if (closing) return Promise.reject(new Error("RTMP relay manager is shutting down"));
    const existing = relaysByLiveId.get(key);
    if (existing && ["starting", "running"].includes(existing.status) && !existing.cleaned) {
      existing.lastAccess = Date.now();
      if (existing.status === "running") return Promise.resolve(publicRelay(existing));
    }
    if (starts.has(key)) return starts.get(key);
    const pending = startRelay(key, streamUrl).finally(() => starts.delete(key));
    starts.set(key, pending);
    return pending;
  }

  function resolveFile(token, fileName) {
    const relay = relaysByToken.get(String(token || ""));
    if (!relay || relay.cleaned || relay.status !== "running") return null;
    if (fileName !== "index.m3u8" && !/^segment_\d{6}\.ts$/.test(String(fileName || ""))) return null;
    const filePath = path.resolve(relay.directory, fileName);
    if (path.dirname(filePath) !== relay.directory) return null;
    if (!fsApi.existsSync(filePath)) return null;
    relay.lastAccess = Date.now();
    return { relay, filePath, contentType: fileName === "index.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t" };
  }

  function serveFile(req, res) {
    const resolved = resolveFile(req.params.token, req.params.fileName);
    if (!resolved) return res.status(404).json({ success: false, error: "Relay file not found" });
    res.set({
      "Content-Type": resolved.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.sendFile(resolved.filePath, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 404).json({ success: false, error: "Relay file not found" });
    });
  }

  function stopRelay(relay) {
    if (!relay || relay.cleaned) return Promise.resolve();
    relay.status = "stopping";
    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const done = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        removeRelay(relay);
        resolve();
      };
      relay.child.once("close", done);
      try { relay.child.kill("SIGTERM"); } catch { done(); return; }
      if (finished) return;
      timer = setTimeout(() => {
        try { relay.child.kill("SIGKILL"); } catch {}
        done();
      }, 5000);
    });
  }

  async function closeAll() {
    closing = true;
    clearInterval(cleanupTimer);
    const initialStops = [...relaysByLiveId.values()].map(stopRelay);
    await Promise.allSettled([...starts.values()]);
    return Promise.allSettled([...initialStops, ...[...relaysByLiveId.values()].map(stopRelay)]);
  }

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const relay of relaysByLiveId.values()) {
      if (relay.lastAccess < cutoff) void stopRelay(relay);
    }
  }, Math.min(30_000, Math.max(1000, Math.floor(idleTimeoutMs / 3))));
  cleanupTimer.unref?.();

  return {
    getOrStart,
    resolveFile,
    serveFile,
    closeAll,
    _internals: { validateRtmpUrl, relayFfmpegArgs, relaysByLiveId, relaysByToken, safeRelayDir },
  };
}

const relayManager = createRelayManager();

module.exports = { createRelayManager, relayFfmpegArgs, relayManager };
