"use strict";

/**
 * DDTalks Meeting Recorder
 *
 * Uses Playwright to open a DDTalks meeting in a headless browser,
 * then captures the display with ffmpeg.
 *
 * Supports two recording modes:
 *   1. browser-only: Playwright records the browser tab via CDP screencast
 *   2. display-capture: ffmpeg captures X11 display (Linux server with xvfb)
 *
 * Requires:
 *   - playwright (npm)
 *   - ffmpeg
 *   - xvfb (Linux) or a visible display
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const manager = require("../recorder/manager");

const HOME = process.env.HOME || process.env.USERPROFILE || "/root";
const DOWNLOAD_DIR = process.env.DDTALKS_DOWNLOAD_DIR || path.join(HOME, ".shn48-data", "ddtalks");
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const DISPLAY = process.env.DISPLAY || ":99"; // xvfb display

// Active recording sessions
const activeSessions = new Map(); // sessionId -> { browser, page, ffmpegProc, recordingId, ... }

// Ensure download directory
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * Start recording a DDTalks meeting.
 * @param {Object} opts
 * @param {string} opts.meetingUrl - The DDTalks meeting join URL
 * @param {string} [opts.meetingName] - Optional meeting name/label
 * @param {string} [opts.userName] - Display name to use when joining
 * @param {number} [opts.durationMinutes] - Max recording duration (default 180)
 * @returns {Object} session info with sessionId
 */
async function startRecording(opts = {}) {
  const { meetingUrl, meetingName, userName, durationMinutes } = opts;

  if (!meetingUrl) throw new Error("meetingUrl is required");

  const sessionId = `ddt_${Date.now()}`;
  const outputFile = path.join(DOWNLOAD_DIR, `${sessionId}.mp4`);
  const maxDuration = (durationMinutes || 180) * 60; // seconds

  const recording = manager.addRecording({
    source: "ddtalks",
    url: meetingUrl,
    name: meetingName || `DDTalks ${new Date().toLocaleString("zh-CN")}`,
    sessionId,
    outputFile,
  });

  manager.updateRecording(recording.id, { status: "starting" });

  const session = {
    sessionId,
    meetingUrl,
    meetingName,
    userName: userName || "Recorder",
    outputFile,
    maxDuration,
    recordingId: recording.id,
    startTime: new Date(),
    browser: null,
    page: null,
    ffmpegProc: null,
    status: "starting",
    error: null,
  };

  activeSessions.set(sessionId, session);

  try {
    // Launch browser
    await launchAndJoin(session);

    // Start ffmpeg display capture
    startFfmpeg(session);

    session.status = "recording";
    manager.updateRecording(recording.id, { status: "recording" });

    // Schedule auto-stop
    session.stopTimer = setTimeout(() => {
      stopRecording(sessionId).catch(console.error);
    }, maxDuration * 1000);

    return {
      sessionId,
      recordingId: recording.id,
      outputFile,
      status: "recording",
    };
  } catch (err) {
    session.status = "failed";
    session.error = err.message;
    manager.updateRecording(recording.id, {
      status: "failed",
      error: err.message,
    });
    throw err;
  }
}

/**
 * Launch Chromium via Playwright, navigate to meeting, and handle join flow.
 */
async function launchAndJoin(session) {
  const { chromium } = require("playwright");

  const browser = await chromium.launch({
    headless: false, // Need visible browser for ffmpeg capture
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=1920,1080`,
      "--window-position=0,0",
      "--use-fake-ui-for-media-stream", // Auto-allow mic/camera prompts
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Navigate to the meeting
  await page.goto(session.meetingUrl, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Wait for page to load and try to handle join flow
  await page.waitForTimeout(3000);

  // Try to auto-join: look for common join buttons
  // DDTalks web typically has buttons like "加入会议", "使用浏览器入会"
  try {
    // Try to click the join/enter button
    const joinSelectors = [
      'button:has-text("加入会议")',
      'button:has-text("进入会议")',
      'button:has-text("使用浏览器入会")',
      'button:has-text("浏览器入会")',
      'button:has-text("Join")',
      'button:has-text("Enter")',
      'a:has-text("加入会议")',
      '[class*="join"]',
      '[class*="enter"]',
    ];

    for (const sel of joinSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    // Try to input a username if prompted
    try {
      const nameInput = page.locator('input[placeholder*="名称"], input[placeholder*="名字"], input[name*="name"], input[placeholder*="Name"]').first();
      if (await nameInput.isVisible({ timeout: 2000 })) {
        await nameInput.fill(session.userName || "Recorder");
        await page.waitForTimeout(500);

        // Click confirm after name input
        const confirmBtns = [
          'button:has-text("确定")',
          'button:has-text("进入")',
          'button:has-text("加入")',
          'button:has-text("OK")',
          'button:has-text("Confirm")',
        ];
        for (const sel of confirmBtns) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 })) {
              await btn.click();
              break;
            }
          } catch {}
        }
      }
    } catch {}

    // Wait for meeting to load
    await page.waitForTimeout(5000);

  } catch (err) {
    console.warn(`[ddtalks] Auto-join attempt: ${err.message}`);
  }

  session.browser = browser;
  session.page = page;
}

/**
 * Start ffmpeg to capture the display/screen.
 */
function startFfmpeg(session) {
  const args = [];

  if (os.platform() === "linux") {
    // Linux: use x11grab (requires xvfb running)
    args.push(
      "-f", "x11grab",
      "-video_size", "1920x1080",
      "-framerate", "15",
      "-i", `${DISPLAY}.0+0,0`,
    );
  } else if (os.platform() === "win32") {
    // Windows: use gdigrab
    args.push(
      "-f", "gdigrab",
      "-framerate", "15",
      "-i", "desktop",
    );
  } else if (os.platform() === "darwin") {
    // macOS: use avfoundation
    args.push(
      "-f", "avfoundation",
      "-framerate", "15",
      "-i", "1:none", // screen capture, no audio
    );
  }

  // Common output settings
  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    session.outputFile,
  );

  const ffmpeg = spawn(FFMPEG_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  ffmpeg.stdout.on("data", d => {
    // ffmpeg outputs status to stderr
  });

  ffmpeg.stderr.on("data", d => {
    // Progress info
  });

  ffmpeg.on("error", err => {
    console.error(`[ddtalks] ffmpeg error for ${session.sessionId}:`, err.message);
    session.status = "failed";
    session.error = err.message;
    manager.updateRecording(session.recordingId, {
      status: "failed",
      error: err.message,
    });
  });

  ffmpeg.on("close", code => {
    console.log(`[ddtalks] ffmpeg exited with code ${code} for ${session.sessionId}`);
  });

  session.ffmpegProc = ffmpeg;
}

/**
 * Stop an active recording session.
 */
async function stopRecording(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  session.status = "stopping";
  manager.updateRecording(session.recordingId, { status: "stopping" });

  // Clear auto-stop timer
  if (session.stopTimer) {
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }

  // Stop ffmpeg
  if (session.ffmpegProc && !session.ffmpegProc.killed) {
    session.ffmpegProc.stdin.write("q"); // Graceful ffmpeg quit
    await new Promise(resolve => {
      session.ffmpegProc.on("close", resolve);
      setTimeout(resolve, 5000); // force after 5s
    });
  }

  // Close browser
  if (session.browser) {
    try { await session.browser.close(); } catch {}
  }

  session.status = "done";
  session.endTime = new Date();

  const stats = fs.existsSync(session.outputFile)
    ? fs.statSync(session.outputFile)
    : null;

  manager.updateRecording(session.recordingId, {
    status: "done",
    fileSize: stats ? stats.size : 0,
    endTime: session.endTime.toISOString(),
  });

  activeSessions.delete(sessionId);

  return {
    sessionId,
    recordingId: session.recordingId,
    outputFile: session.outputFile,
    fileSize: stats ? stats.size : 0,
    duration: session.endTime - session.startTime,
    status: "done",
  };
}

/**
 * Get status of a recording session.
 */
function getSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    // Check if it's in recordings
    const recs = manager.getRecordings();
    const rec = recs.find(r => r.sessionId === sessionId);
    if (rec) {
      return { sessionId, ...rec, active: false };
    }
    return null;
  }
  return {
    sessionId: session.sessionId,
    recordingId: session.recordingId,
    meetingUrl: session.meetingUrl,
    meetingName: session.meetingName,
    outputFile: session.outputFile,
    status: session.status,
    error: session.error,
    startTime: session.startTime,
    active: true,
  };
}

/**
 * List all active and recent sessions.
 */
function listSessions() {
  const active = [];
  for (const [id, session] of activeSessions) {
    active.push({
      sessionId: id,
      recordingId: session.recordingId,
      meetingName: session.meetingName,
      status: session.status,
      startTime: session.startTime,
      active: true,
    });
  }

  const recorded = manager
    .getRecordings({ source: "ddtalks" })
    .filter(r => !activeSessions.has(r.sessionId));

  return { active, recorded };
}

module.exports = {
  startRecording,
  stopRecording,
  getSession,
  listSessions,
};
