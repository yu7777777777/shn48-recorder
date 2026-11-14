"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const liveService = require("../modules/pocket48/live");
const replayService = require("../modules/pocket48/replay");
const replayProxy = require("../modules/pocket48/replay-proxy");
const replayDanmaku = require("../modules/pocket48/replay-danmaku");
const replayDownload = require("../modules/recorder/replay-download");
const replayRecovery = require("../modules/recorder/replay-recovery");
const pocketRecorder = require("../modules/pocket48/recorder");
const streamProxy = require("../modules/pocket48/stream-proxy");
const playbackPolicy = require("../modules/pocket48/playback-policy");
const members = require("../modules/pocket48/members");
const manager = require("../modules/recorder/manager");
const analysisService = require("../modules/analysis/service");
const analysisSettings = require("../modules/analysis/settings");
const { danmakuManager } = require("../modules/pocket48/danmaku");
const { relayManager } = require("../modules/pocket48/rtmp-relay");
// `version` is a function: it must be called. Destructuring alone would bind the
// function object, and `JSON.stringify` drops a function, so the health payload
// would silently lose its `version` field.
const APP_VERSION = require("../lib/version").version();

const router = express.Router();
const replayDownloadJobs = new Map();
const MAX_REPLAY_DOWNLOAD_JOBS = 2;

function replayDownloadName(replay) {
  const date = replay?.startedAt ? new Date(replay.startedAt) : null;
  const datePart = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "replay";
  const base = pocketRecorder._internals.safeName(
    `${datePart}-${replay?.member?.name || "Pocket48"}-${replay?.title || "直播回放"}`
  );
  return `${base || "pocket48-replay"}.mp4`;
}

function ensureReplayDownload(liveId, replay) {
  const id = String(liveId);
  const existing = replayDownloadJobs.get(id);
  if (existing) return existing;
  if ([...replayDownloadJobs.values()].filter((job) => ["preparing", "verifying"].includes(job.status)).length >= MAX_REPLAY_DOWNLOAD_JOBS) {
    const error = new Error("下载任务繁忙，请稍后重试");
    error.statusCode = 429;
    throw error;
  }
  const state = { status: "preparing", progress: 0, filePath: null, fileName: replayDownloadName(replay), error: null, validation: "pending" };
  replayDownloadJobs.set(id, state);
  void Promise.resolve().then(() => replayDownload.downloadShared({
    liveId: id,
    directory: replayRecovery._internals.directory(id),
    verify: false,
    onProgress({ completed, total, verifying }) {
      state.status = verifying ? "verifying" : "preparing";
      state.progress = total ? Math.floor(completed / total * 100) : 0;
    },
  })).then((official) => {
    state.status = "ready";
    state.progress = 100;
    state.filePath = official.filePath;
    state.validation = "verifying";
    void replayDownload.downloadShared({
      liveId: id,
      directory: replayRecovery._internals.directory(id),
      verify: true,
    }).then(() => {
      state.validation = "passed";
    }).catch(() => {
      state.validation = "failed";
    });
  }).catch(() => {
    state.status = "failed";
    state.error = "回放暂时无法完整下载，请稍后重试";
  }).finally(() => {
    state.finishedAt = Date.now();
    setTimeout(() => {
      if (replayDownloadJobs.get(id) === state) replayDownloadJobs.delete(id);
    }, 10 * 60 * 1000).unref?.();
  });
  return state;
}

router.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", version: APP_VERSION } });
});

router.get("/live", async (req, res) => {
  try {
    const data = await liveService.listLives(req.query.groupId || 0, req.query.next || "0");
    // `liveList` preserves the established frontend shape; `list` is the concise alias.
    res.json({ success: true, data: { ...data, liveList: data.list || [] } });
  } catch (err) {
    res.json({ success: true, data: { list: [], liveList: [], next: "0" } });
  }
});

router.get("/live/:liveId", async (req, res) => {
  try {
    const { live } = await liveService.getLive(req.params.liveId);
    res.json({ success: true, data: live });
  } catch (err) {
    res.status(502).json({ success: false, error: "Unable to load live details" });
  }
});

router.get("/live/:liveId/play", async (req, res) => {
  try {
    const { live, streamUrl } = await liveService.getLive(req.params.liveId);
    if (!streamUrl) return res.status(404).json({ success: false, error: "Live stream is unavailable" });
    const sourceProtocol = new URL(streamUrl).protocol;
    if (sourceProtocol === "rtmp:") {
      const relay = await relayManager.getOrStart({ liveId: live.liveId, streamUrl });
      return res.json({
        success: true,
        data: {
          liveId: live.liveId,
          protocol: "hls",
          playUrl: relay.playUrl,
          startedAt: relay.startedAt,
        },
      });
    }
    const protocol = liveService.playbackProtocol(streamUrl);
    const forceServer = req.query.fallback === "server";
    res.json({ success: true, data: playbackPolicy.createHttpPlayback({
      liveId: live.liveId,
      streamUrl,
      protocol,
      priority: playbackPolicy.readLivePriority(),
      forceServer,
      streamProxy,
    }) });
  } catch (err) {
    res.status(502).json({ success: false, error: "Live stream is unavailable" });
  }
});

router.get("/live/:liveId/danmaku", async (req, res) => {
  let unsubscribe = null;
  let heartbeat = null;
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const { roomId } = await liveService.getLive(liveId);
    if (!roomId) return res.status(404).json({ success: false, error: "Live danmaku is unavailable" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    unsubscribe = danmakuManager.subscribe(roomId, send);
    heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 20_000);
    heartbeat.unref?.();
    req.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = null;
    });
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (!res.headersSent) {
      res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 ? err.message : "Live danmaku is unavailable" });
    } else {
      res.end();
    }
  }
});

function numericQuery(value, name, { optional = false } = {}) {
  if ((value === undefined || value === "") && optional) return undefined;
  const text = String(value === undefined ? "0" : value);
  if (!/^\d{1,32}$/.test(text)) {
    const error = new Error(`Invalid ${name}`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function replayStartedAt(item) {
  const raw = item?.startedAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : 0;
  }
  const parsed = Date.parse(raw || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

router.get("/replays", async (req, res) => {
  try {
    const next = numericQuery(req.query.next || "0", "next");
    let groupId = numericQuery(req.query.groupId, "groupId", { optional: true });
    let userId = numericQuery(req.query.userId, "userId", { optional: true });
    let teamId = req.query.teamId === undefined || req.query.teamId === "" ? undefined : String(req.query.teamId).toLowerCase();
    const memberName = req.query.memberName === undefined ? "" : String(req.query.memberName).trim().slice(0, 64);
    let search = null;
    if (memberName && !userId) {
      const roster = await members.listRoster();
      const matchedMembers = members.findMembersByName(roster.list, memberName);
      if (matchedMembers.length) {
        // A member feed is already narrower than a group/team feed.  Do not
        // combine upstream filters that Pocket48 treats as mutually exclusive.
        groupId = undefined;
        teamId = undefined;
        search = {
          query: memberName,
          applied: true,
          members: matchedMembers.map((member) => ({ memberId: member.memberId, memberName: member.memberName })),
        };
      } else {
        search = { query: memberName, applied: false };
      }
    }
    if (groupId !== undefined && userId !== undefined) {
      return res.status(400).json({ success: false, error: "groupId and userId are mutually exclusive" });
    }
    if (teamId !== undefined && !replayService.isTeamInGroup(groupId, teamId)) {
      return res.status(400).json({ success: false, error: "teamId does not belong to groupId" });
    }
    const data = search?.applied
      ? {
          list: (await Promise.all(search.members.map((member) => replayService.listReplays({
            next,
            userId: member.memberId,
            limit: Math.ceil(replayService._internals.MEMBER_SEARCH_LIMIT / search.members.length),
          })))).flatMap((page) => page.list)
            .filter((item, index, list) => list.findIndex((candidate) => candidate.liveId === item.liveId) === index)
            .sort((a, b) => replayStartedAt(b) - replayStartedAt(a))
            .slice(0, replayService._internals.MEMBER_SEARCH_LIMIT),
          next: "0",
        }
      : await replayService.listReplays({ next, groupId, userId, teamId });
    res.json({ success: true, data: { ...data, ...(search ? { search } : {}) } });
  } catch (err) {
    res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 ? err.message : "Unable to load replay list" });
  }
});

router.get("/replays/:liveId/play", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const { replay, streamUrl, danmakuUrl } = await replayService.getReplay(liveId);
    if (!streamUrl) return res.status(404).json({ success: false, error: "Replay stream is unavailable" });
    if (liveService.playbackProtocol(streamUrl) !== "hls") {
      return res.status(502).json({ success: false, error: "Replay stream format is unsupported" });
    }
    const session = replayProxy.getOrCreate({
      replayId: replay.liveId,
      streamUrl,
      durationSeconds: replay.durationSeconds,
    });
    res.json({
      success: true,
      data: {
        liveId: replay.liveId,
        protocol: "hls",
        playUrl: session.playUrl,
        expiresAt: new Date(session.expiresAt).toISOString(),
        danmakuAvailable: Boolean(danmakuUrl),
      },
    });
  } catch (err) {
    res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 ? err.message : "Replay stream is unavailable" });
  }
});

router.post("/replays/:liveId/download", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const existing = replayDownloadJobs.get(liveId);
    let replay = existing?.replay || null;
    if (!existing || existing.status === "failed") {
      const detail = await replayService.getReplay(liveId);
      replay = detail.replay;
      const { streamUrl } = detail;
      if (!streamUrl) return res.status(404).json({ success: false, error: "回放视频暂不可用" });
      if (existing) replayDownloadJobs.delete(liveId);
    }
    const state = ensureReplayDownload(liveId, replay);
    state.replay = replay;
    res.status(state.status === "ready" ? 200 : 202).json({ success: true, data: { status: state.status, progress: state.progress, error: state.error } });
  } catch (err) {
    res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 || err.statusCode === 429 ? err.message : "回放下载暂不可用" });
  }
});

router.get("/replays/:liveId/download/status", (req, res) => {
  try {
    const state = replayDownloadJobs.get(numericQuery(req.params.liveId, "liveId"));
    res.json({ success: true, data: state ? { status: state.status, progress: state.progress, error: state.error, validation: state.validation } : { status: "idle", progress: 0 } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get("/replays/:liveId/download", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const state = replayDownloadJobs.get(liveId);
    if (state?.status !== "ready") return res.status(409).json({ success: false, error: "回放视频尚未准备完成" });
    const filePath = path.resolve(state.filePath);
    const root = path.resolve(replayRecovery._internals.directory(liveId));
    const relative = path.relative(root, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(filePath).isFile()) {
      return res.status(500).json({ success: false, error: "Replay download file is invalid" });
    }
    res.download(filePath, state.fileName || replayDownloadName(state.replay), (error) => {
      if (error && !res.headersSent) res.status(502).json({ success: false, error: "Unable to download replay" });
    });
  } catch (err) {
    res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 ? err.message : "Replay download is temporarily unavailable" });
  }
});

router.get("/replays/:liveId/danmaku", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const { danmakuUrl } = await replayService.getReplay(liveId);
    const list = await replayDanmaku.load(liveId, danmakuUrl);
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, data: { available: true, count: list.length, list } });
  } catch (err) {
    const status = err.statusCode === 404 ? 404 : 502;
    res.status(status).json({ success: false, error: status === 404 ? "Replay danmaku is unavailable" : "Unable to load replay danmaku" });
  }
});

router.get("/replays/:liveId", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const { replay } = await replayService.getReplay(liveId);
    res.json({ success: true, data: replay });
  } catch (err) {
    res.status(err.statusCode || 502).json({ success: false, error: err.statusCode === 400 ? err.message : "Unable to load replay details" });
  }
});

// Public analysis: only an administrator-published summary of a finished archive.
// Subtitle text, model, endpoint, provenance and job state stay behind the admin
// API; this endpoint exists so a shared replay link can show what it is about.
function publicSummary(data, publish, detail = 'full') {
  const rows = (list) => (Array.isArray(list) ? list : []).filter(row => row && typeof row === 'object').map(row => ({
    start: Number.isFinite(row.start) ? row.start : null,
    end: Number.isFinite(row.end) ? row.end : null,
    title: String(row.title ?? '').slice(0, 200),
    summary: String(row.summary ?? '').slice(0, 4000)
  })).filter(row => row.start !== null && row.end !== null);
  return {
    recordingId: String(data.recordingId),
    // 'chapters' mode publishes titles and times only; the prose is withheld.
    detail,
    summary: detail === 'chapters' ? '' : String(data.summary).slice(0, 20000),
    // Administrators choose what a visitor may see; the switches default to
    // "summary only" so a replay never silently starts publishing chapters.
    chapters: publish.chapters ? rows(data.chapters) : [],
    highlights: publish.highlights ? rows(data.highlights) : []
  };
}
// One lookup for both the JSON endpoint and the share card, so a preview can
// never describe a replay the endpoint would refuse.
function publishedSummaryFor(liveId) {
  const archive = manager.getRecordings().find(rec => rec && String(rec.liveId || "") === String(liveId) && rec.source === "pocket48" && rec.mediaType !== "audio" && rec.segment !== true && rec.source !== "clip" && rec.status === "done");
  if (!archive) return null;
  const config = analysisSettings.get();
  if (config.publish.summary !== true) return null;
  const analysis = analysisService.result(archive.id);
  if (typeof analysis.summary !== "string" || !analysis.summary.trim()) return null;
  return { ...analysis, recordingId: archive.id, title: String(archive.title || archive.name || "") };
}
router.get("/replays/:liveId/summary", async (req, res) => {
  try {
    const liveId = numericQuery(req.params.liveId, "liveId");
    const archive = manager.getRecordings().find(rec => rec && String(rec.liveId || '') === String(liveId) && rec.source === 'pocket48' && rec.mediaType !== 'audio' && rec.segment !== true && rec.source !== 'clip' && rec.status === 'done');
    if (!archive) return res.status(404).json({ success: false, error: "Replay summary is unavailable" });
    const config = analysisSettings.get(), publish = config.publish;
    if (publish.summary !== true) return res.status(404).json({ success: false, error: "Replay summary is unavailable" });
    const analysis = analysisService.result(archive.id);
    if (typeof analysis.summary !== 'string' || !analysis.summary.trim()) return res.status(404).json({ success: false, error: "Replay summary is unavailable" });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: publicSummary({ ...analysis, recordingId: archive.id }, publish, config.publicDetail?.mode) });
  } catch (err) {
    // A missing archive or an analysis that cannot be read is indistinguishable to a
    // visitor on purpose: neither should reveal whether an admin is preparing one.
    res.status(err.statusCode === 400 ? 400 : 404).json({ success: false, error: err.statusCode === 400 ? err.message : "Replay summary is unavailable" });
  }
});

// Guest view of one member's social directory, reached only with a valid code.
router.get("/social/:code", (req, res) => {
  try {
    const access = require("../modules/social/access");
    const granted = access.resolve(req.params.code);
    if (!granted) return res.status(404).json({ success: false, error: "邀请链接无效或已过期" });
    const accounts = access.publicAccounts(require("../modules/social/accounts").repository().list().accounts, granted.memberName);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: { memberName: granted.memberName, accounts } });
  } catch (err) {
    res.status(404).json({ success: false, error: "邀请链接无效或已过期" });
  }
});

router.get("/streams/:token", streamProxy.proxyToken);
router.get("/relays/:token/:fileName", relayManager.serveFile);
router.get("/replay-streams/:sessionToken/manifest", replayProxy.serveManifest);
router.get("/replay-streams/:sessionToken/resource/:childToken", replayProxy.serveResource);

router.publishedSummaryFor = publishedSummaryFor;
module.exports = router;
module.exports._internals = { replayStartedAt };
