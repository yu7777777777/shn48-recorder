"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const manager = require("../modules/recorder/manager");
const store = require("../lib/store");
const biliDraft = require("../modules/bilibili/draft");
const uploadQueue = require("../modules/bilibili/queue");
const { accountService } = require("../modules/bilibili/account");

const router = express.Router();
const HOME = process.env.HOME || process.env.USERPROFILE || "/root";
const COVERS_DIR = process.env.COVERS_DIR || path.join(HOME, ".shn48-data", "covers");
fs.mkdirSync(COVERS_DIR, { recursive: true });

function getCredentialsOr401(res) {
  try {
    const creds = uploadQueue.getCredentials();
    if (!creds) {
      res.status(401).json({ success: false, error: "Bilibili is not logged in" });
      return null;
    }
    return creds;
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
    return null;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
      },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve({ data: JSON.parse(body), headers: response.headers, status: response.statusCode }); }
        catch { reject(new Error("Invalid Bilibili response")); }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error("Bilibili request timeout")));
    request.on("error", reject);
  });
}

function credentialsFromLogin(data, headers) {
  const map = {};
  const loginUrl = data && data.data && data.data.url;
  if (loginUrl) {
    const parsed = new URL(loginUrl);
    for (const part of parsed.search.slice(1).split("&")) {
      const pos = part.indexOf("=");
      if (pos <= 0) continue;
      const key = decodeURIComponent(part.slice(0, pos));
      // Preserve percent escapes in cookie values (notably SESSDATA's %2C).
      map[key] = part.slice(pos + 1);
    }
  }
  const setCookies = headers["set-cookie"] || [];
  for (const line of setCookies) {
    const pair = String(line).split(";", 1)[0];
    const pos = pair.indexOf("=");
    if (pos > 0) map[pair.slice(0, pos)] = pair.slice(pos + 1);
  }
  if (!map.SESSDATA) throw new Error("Bilibili login succeeded without SESSDATA");
  return {
    cookie_info: {
      cookies: Object.entries(map).map(([name, value]) => ({ name, value, domain: ".bilibili.com", path: "/" })),
    },
    token_info: {
      mid: map.DedeUserID || "",
      access_token: "",
      refresh_token: (data.data && data.data.refresh_token) || "",
    },
    savedAt: new Date().toISOString(),
  };
}

function saveCredentials(data) {
  store.atomicWrite(uploadQueue.COOKIES_PATH, data);
}

async function accountStatus(_req, res) {
  const data = await accountService.getStatus({
    loadCredentials: uploadQueue.getCredentials,
    credentialsPresent: fs.existsSync(uploadQueue.COOKIES_PATH),
  });
  // A credentials file can already exist (for example after a restored volume).
  // Once it is confirmed valid, only wake tasks parked on missing credentials;
  // restart recovery runs at queue load and server startup, and polling must
  // never touch uploads that are live or paused behind an active recording.
  if (data.authenticated) uploadQueue.resumeWaitingForCredentials();
  res.json({ success: true, data });
}

router.get("/status", accountStatus);
router.get("/account", accountStatus);

router.post("/logout", (_req, res) => {
  try { if (fs.existsSync(uploadQueue.COOKIES_PATH)) fs.unlinkSync(uploadQueue.COOKIES_PATH); } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
  accountService.clearCache();
  res.json({ success: true });
});

router.get("/drafts", async (req, res) => {
  const creds = getCredentialsOr401(res);
  if (!creds) return;
  try {
    const pn = Math.max(1, Number(req.query.pn) || 1);
    const ps = Math.max(1, Math.min(100, Number(req.query.ps) || 20));
    const list = await biliDraft.listDrafts({ cookie: creds.cookie, pn, ps });
    for (const draft of list) {
      let recording = manager.getRecordings().find(item => item.draftId && String(item.draftId) === String(draft.draftId));
      if (!recording && draft.videoCid) {
        const matches = manager.getQueue().filter(item => item.status === "done" && item.mode !== "publish" && Number(item.uposBizId) === draft.videoCid);
        if (matches.length === 1) {
          const candidate = manager.getRecording(matches[0].recordingId);
          if (candidate && (!candidate.draftId || String(candidate.draftId) === draft.draftId)) {
            recording = manager.updateRecording(candidate.id, { draftId: draft.draftId, uploadStatus: "done" });
            manager.updateQueueItem(matches[0].id, { draftId: draft.draftId });
          }
        }
      }
      if (recording) {
        draft.recordingId = recording.id;
        draft.coverSyncPending = Boolean(recording.coverSyncPending);
        draft.liveType = recording.liveType ?? null;
        draft.liveMode = recording.liveMode ?? null;
        if (!draft.cover && !recording.coverFile && recording.status === "done") {
          try { await require("../modules/recorder/covers").generate(recording); } catch { /* Missing local media must not hide upstream drafts. */ }
        }
        draft.cover = draft.cover || require("../modules/recorder/covers").url(recording);
        draft.durationSeconds = recording.durationSeconds || 0;
      }
    }
    res.json({ success: true, data: list, summary: { total: list.length, page: pn, pageSize: ps } });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

router.get("/draft/:draftId", async (req, res) => {
  const creds = getCredentialsOr401(res);
  if (!creds) return;
  try {
    const detail = await biliDraft.viewDraft({ cookie: creds.cookie, draftId: req.params.draftId });
    res.json({ success: true, data: detail });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

const deletingDrafts = new Set();
router.delete("/draft/:draftId", async (req, res) => {
  let id;
  try { id = biliDraft.validateDraftId(req.params.draftId); }
  catch (error) { return res.status(400).json({ success: false, error: error.message }); }
  if (req.body?.confirmed !== true) return res.status(400).json({ success: false, error: "请先确认删除这条 B站草稿" });
  const creds = getCredentialsOr401(res);
  if (!creds) return;
  const key = `${creds.mid || "current"}:${id}`;
  if (deletingDrafts.has(key)) return res.status(409).json({ success: false, error: "该草稿正在删除，请勿重复操作" });
  deletingDrafts.add(key);
  try {
    const result = await biliDraft.deleteDraft({ cookie: creds.cookie, csrf: creds.csrf, draftId: id });
    // Upload history remains history. Never delete the recording or requeue it.
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message });
  } finally { deletingDrafts.delete(key); }
});

router.post("/draft/:draftId/publish", async (req, res) => {
  const creds = getCredentialsOr401(res);
  if (!creds) return;
  try {
    const result = await biliDraft.publishDraft({ cookie: creds.cookie, csrf: creds.csrf, draftId: req.params.draftId });
    res.json({ success: true, data: result });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

router.get("/queue", (_req, res) => {
  const queue = manager.getQueue();
  res.json({ success: true, data: queue.map(uploadQueue.toQueueDto), summary: uploadQueue.summarizeQueue(queue) });
});

router.post("/queue/:id/retry", (req, res) => {
  try { res.json({ success: true, data: uploadQueue.toQueueDto(uploadQueue.retry(req.params.id)) }); }
  catch (err) {
    const status = err.statusCode || (err.message.includes("not found") ? 404 : 409);
    const body = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.existingItem) body.data = uploadQueue.toQueueDto(err.existingItem);
    res.status(status).json(body);
  }
});

// Compatibility with the earlier route shape while still executing the retry.
router.post("/queue/retry", (req, res) => {
  try { res.json({ success: true, data: uploadQueue.toQueueDto(uploadQueue.retry(req.body && req.body.id)) }); }
  catch (err) {
    const status = err.statusCode || (err.message.includes("not found") ? 404 : 409);
    const body = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.existingItem) body.data = uploadQueue.toQueueDto(err.existingItem);
    res.status(status).json(body);
  }
});

router.delete("/queue/:id", (req, res) => {
  const item = manager.getQueueItem(req.params.id);
  // isUploadInFlight is the pump's own ground truth: an in-flight upload stays
  // undeletable even if its queue status were ever to lag behind.
  if (item && (["uploading", "paused_recording"].includes(item.status) || uploadQueue.isUploadInFlight(item.id))) return res.status(409).json({ success: false, error: "Cannot delete an active upload" });
  const removed = manager.dequeueUpload(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: "Upload queue item not found" });
  res.json({ success: true, data: uploadQueue.toQueueDto(removed) });
});

router.post("/upload", (req, res) => {
  try {
    const { recordingId, ...options } = req.body || {};
    if (!recordingId) return res.status(400).json({ success: false, error: "recordingId is required" });
    const item = uploadQueue.enqueueRecording(recordingId, options);
    res.status(202).json({ success: true, data: uploadQueue.toQueueDto(item) });
  } catch (err) {
    const status = err.statusCode || (err.message.includes("not found") ? 404 : 400);
    const body = { success: false, error: err.message };
    if (err.code) body.code = err.code;
    if (err.existingItem) body.data = uploadQueue.toQueueDto(err.existingItem);
    res.status(status).json(body);
  }
});

router.get("/qrcode", async (_req, res) => {
  try {
    const QRCode = require("qrcode");
    const result = await getJson("https://passport.bilibili.com/x/passport-login/web/qrcode/generate");
    if (result.data.code !== 0) return res.status(502).json({ success: false, error: result.data.message || "Unable to create QR code" });
    const png = await QRCode.toBuffer(result.data.data.url, { width: 240, margin: 2 });
    res.json({
      success: true,
      data: { qrcode_key: result.data.data.qrcode_key, qrcodeKey: result.data.data.qrcode_key, qrcode: `data:image/png;base64,${png.toString("base64")}` },
    });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

router.get("/qrcode/check", async (req, res) => {
  const key = String(req.query.key || "");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(key)) return res.status(400).json({ success: false, error: "Invalid qrcode key" });
  try {
    const result = await getJson(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`);
    const state = result.data.data || {};
    const authenticated = Number(state.code) === 0;
    if (authenticated) {
      saveCredentials(credentialsFromLogin(result.data, result.headers));
      accountService.clearCache();
      // Fresh credentials only need to wake credential-parked tasks; restart
      // recovery is not this path's job.
      uploadQueue.resumeWaitingForCredentials();
    }
    res.json({
      success: true,
      data: { authenticated, code: Number(state.code), message: state.message || "", saved: authenticated },
    });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

router.get("/covers", (_req, res) => {
  try {
    const files = fs.readdirSync(COVERS_DIR).filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
    res.json({ success: true, data: files });
  } catch { res.json({ success: true, data: [] }); }
});

module.exports = router;
module.exports._internals = { credentialsFromLogin, saveCredentials, accountStatus };
