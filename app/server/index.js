"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const sse = require("./lib/sse");
const manager = require("./modules/recorder/manager");
const pocketRecorder = require("./modules/pocket48/recorder");
const auth = require("./lib/admin-auth");
const { createGracefulShutdown } = require("./lib/graceful-shutdown");
const archiveProcessor = require("./modules/recorder/archive-processor");
// `version` is a function: it must be called, otherwise the binding is the
// function object and a template literal prints its source instead of the number.
const APP_VERSION = require("./lib/version").version();

function getStorageStats(recordingsDir = pocketRecorder._internals.recordingsDir(), statfs = fs.statfsSync) {
  const stats = statfs(recordingsDir, { bigint: true });
  const blockSize = BigInt(stats.bsize || stats.frsize || 0);
  const total = BigInt(stats.blocks || 0) * blockSize;
  const free = BigInt(stats.bavail ?? stats.bfree ?? 0) * blockSize;
  if (total <= 0n) throw new Error("Disk capacity is unavailable");
  const used = total > free ? total - free : 0n;
  return {
    total: Number(total),
    free: Number(free),
    used: Number(used),
    usedPercent: Number((used * 1000n) / total) / 10,
  };
}

function safeStorageStats() {
  try {
    return getStorageStats();
  } catch {
    return null;
  }
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

  app.use("/api/public", require("./routes/public"));
  app.use("/api/admin", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/admin/auth", require("./routes/auth"));

  // Everything below this mount is private, regardless of what the frontend renders.
  app.use("/api/admin", auth.requireAdmin);

  app.get("/api/admin/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("event: connected\ndata: {}\n\n");
    sse.addClient(res);
  });

  app.get("/api/admin/health", (_req, res) => {
    const recordings = manager.getRecordings();
    const storage = safeStorageStats();
    res.json({
      success: true,
      data: {
        uptime: process.uptime(),
        version: APP_VERSION,
        sseClients: sse.getClientCount(),
        recordings: recordings.length,
        recordingsSize: recordings.reduce((total, item) => total + (Number(item.fileSize || item.size) || 0), 0),
        diskFree: storage?.free,
        diskTotal: storage?.total,
        storage,
        uploadQueue: manager.getQueue().length,
      },
    });
  });

  app.use("/api/admin/pocket48", require("./routes/pocket48"));
  app.use("/api/admin/bilibili", require("./routes/bilibili"));
  app.use("/api/admin/recordings", require("./routes/recordings"));
  app.use("/api/admin/config", require("./routes/config"));
  app.use("/api/admin/backup115", require("./routes/backup115"));
  app.use("/api/admin/update", require("./routes/update-checker"));
  app.use("/api/admin/social", require("./routes/social"));

  // API paths never fall through to the SPA; removed legacy endpoints return 404.
  app.use("/api", (_req, res) => res.status(404).json({ success: false, error: "API endpoint not found" }));

  const staticDir = path.join(__dirname, "..", "client", "dist");
  // The Weibo helper page was removed in 1.27.2. Keep its old address from
  // silently rendering the SPA shell, so stale links fail visibly instead of
  // looking like a broken admin page.
  app.get("/weibo-session", (_req, res) => res.status(404).type("text/plain").send("该功能已移除"));
  app.use(express.static(staticDir));
  app.get("*", (req, res) => {
    const indexFile = path.join(staticDir, "index.html");
    if (!fs.existsSync(indexFile)) return res.status(200).send(`48tools ${APP_VERSION} - Frontend not built yet. Run: cd client && npm run build`);
    return res.sendFile(indexFile);
  });

  // Body-parser and route errors carry an HTTP status: client errors (400-499,
  // e.g. malformed or oversized JSON bodies) pass through with their message;
  // everything else stays a logged 500 without leaking error details.
  app.use((err, _req, res, _next) => {
    console.error("[server] unhandled error:", err);
    if (res.headersSent) return;
    const status = Number(err?.status || err?.statusCode) || 0;
    if (status >= 400 && status < 500) return res.status(status).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  return app;
}

function startServer() {
  const port = Number(process.env.PORT) || 3000;
  if (process.env.NODE_ENV === "production" && !auth.configured()) {
    throw new Error("Production requires ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET (16+ chars)");
  }
  const app = createApp();
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`48tools ${APP_VERSION} recording hub listening on http://0.0.0.0:${port}`);
    if (!auth.configured()) {
      console.warn("[auth] ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET (16+ chars) must be configured before admin login is enabled");
    }
    require("./modules/bilibili/queue").resumeQueued();
    archiveProcessor.start();
    void require("./modules/backup115/service").service().start().catch(() => console.error("[backup115] startup paused; inspect backup settings"));
    require("./modules/recorder/retention").start();
    require("./modules/pocket48/auto-recorder").start();
    require("./modules/recorder/replay-audit").start();
    require("./modules/pocket48/auto-checkin").start();
  require("./modules/update-checker").start();
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const shutdown = createGracefulShutdown({
    server,
    stopRecorders: () => Promise.allSettled([
      require("./modules/pocket48/recorder").stopAll(),
      require("./modules/backup115/service").service().stop(),
      require("./modules/pocket48/rtmp-relay").relayManager.closeAll(),
      Promise.resolve(require("./modules/pocket48/danmaku").danmakuManager.closeAll()),
    ]),
    closeEvents: () => {
      sse.closeAll();
      archiveProcessor.stop();
      require("./modules/recorder/retention").stop();
      require("./modules/recorder/replay-audit").stop();
      require("./modules/pocket48/auto-recorder").stop();
      require("./modules/pocket48/auto-checkin").stop();
  require("./modules/update-checker").stop();
    },
    saveState: () => {
      manager.saveRecordings();
      manager.saveQueue();
    },
    forceClose: () => {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
    },
    timeoutMs: Math.max(5_000, Number(process.env.SHUTDOWN_TIMEOUT_MS) || 20_000),
  });
  process.on("SIGINT", () => { void shutdown.shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown.shutdown("SIGTERM"); });
  // Last-resort process handlers. A rejected background promise (e.g. one failed
  // finalize state write) is logged and must not kill the process; an uncaught
  // exception gets one best-effort state save (each save guarded on its own, so
  // one failure cannot skip the other) before the process exits with code 1.
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaught exception:", err);
    for (const save of [() => manager.saveRecordings(), () => manager.saveQueue()]) {
      try { save(); } catch (saveError) { console.error("[server] emergency state save failed:", saveError); }
    }
    setTimeout(() => { process.exitCode = 1; process.exit(1); }, 3000);
  });
  server.shutdown = shutdown.shutdown;
  return server;
}

if (require.main === module) startServer();

module.exports = { createApp, startServer, getStorageStats };
