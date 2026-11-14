"use strict";

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const playbackPolicy = require("../modules/pocket48/playback-policy");

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "..", "config", "config.yaml");

const defaultConfig = {
  ffmpeg: "ffmpeg",
  pocket48: {
    live: { recordName: [], downloadDir: ".download_dir/live" },
    video: { downloadDir: ".download_dir/video" },
  },
  ddtalks: {
    downloadDir: ".download_dir/ddtalks",
    maxDurationMinutes: 180,
    autoJoin: true,
  },
  auto_upload_bili: true,
  bili_upload_mode: "draft",
  bili_upcdn: "bda2",
  draft_api_format: "auto",
  default_tid: 171,
  default_tags: "SNH48,直播",
  default_copyright: 1,
  default_desc: "",
  default_cover: "",
  default_submit: "web",
  playback: { livePriority: playbackPolicy.DEFAULT_LIVE_PRIORITY },
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
    }
  } catch (e) {
    console.error("[config] load error:", e.message);
  }
  return {};
}

// Write the YAML through a temporary file so a crash, an OOM kill or a full
// disk during the write cannot leave a truncated config behind. `loadConfig`
// swallows parse errors and returns `{}`, which would silently reset every
// stored setting (ffmpeg path, upload defaults, playback policy) with no signal
// to the operator. Frame the write the same way `lib/store.atomicWrite` does for
// JSON state, and keep the previous file as a one-step backup.
function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const payload = yaml.dump(config, { lineWidth: 120 });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;

  let handle = null;
  try {
    handle = fs.openSync(temp, "w", 0o600);
    fs.writeFileSync(handle, payload, "utf8");
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    fs.renameSync(temp, CONFIG_PATH);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

router.get("/", (req, res) => {
  const saved = loadConfig();
  const config = {
    ...defaultConfig,
    ...saved,
    playback: {
      ...defaultConfig.playback,
      ...(saved.playback || {}),
      livePriority: playbackPolicy.normalizeLivePriority(saved?.playback?.livePriority),
    },
  };
  res.json({ success: true, data: config });
});

router.put("/", (req, res) => {
  try {
    const requestedPriority = req.body?.playback?.livePriority;
    if (requestedPriority !== undefined && !playbackPolicy.LIVE_PRIORITIES.has(requestedPriority)) {
      return res.status(400).json({ success: false, error: "Invalid live playback priority" });
    }
    const current = loadConfig();
    const merged = {
      ...current,
      ...req.body,
      playback: {
        ...(current.playback || {}),
        ...(req.body?.playback || {}),
        livePriority: playbackPolicy.normalizeLivePriority(requestedPriority ?? current?.playback?.livePriority),
      },
    };
    saveConfig(merged);
    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test: check if ffmpeg is available.
// `spawn` ignores the `timeout` option, so the deadline is enforced by hand —
// otherwise a wedged ffmpeg would leave this request open indefinitely.
router.get("/test-ffmpeg", async (req, res) => {
  const { spawn } = require("child_process");
  const ffmpeg = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { ffmpeg.kill("SIGKILL"); } catch { /* already gone */ }
    res.json({ success: true, data: { available: false, error: "ffmpeg 检测超时" } });
  }, 5000);

  const reply = payload => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    res.json({ success: true, data: payload });
  };

  ffmpeg.stdout.on("data", d => out += d);
  ffmpeg.on("close", code => {
    if (code === 0) {
      const firstLine = out.split("\n")[0] || "";
      reply({ available: true, version: firstLine });
    } else {
      reply({ available: false });
    }
  });
  ffmpeg.on("error", () => reply({ available: false, error: "ffmpeg not found" }));
});

// Test: check if Playwright is available (for DDTalks)
router.get("/test-playwright", async (req, res) => {
  try {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    res.json({ success: true, data: { available: true } });
  } catch (err) {
    res.json({ success: true, data: { available: false, error: err.message } });
  }
});

module.exports = router;
module.exports._internals = { defaultConfig, loadConfig, saveConfig };
