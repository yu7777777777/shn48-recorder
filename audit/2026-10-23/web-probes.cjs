"use strict";
// Read-only probes: extract exact audited source into isolated VMs.
// Run from repository root: node audit/2026-10-23/web-probes.cjs
// No HTTP, filesystem writes, actual timers, or third-party modules.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
function cut(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Source markers changed: ${start}`);
  return source.slice(a, b);
}

async function main() {
  const live = read("app/client/src/pages/PublicLive.jsx");
  const replay = read("app/client/src/pages/PublicReplay.jsx");
  const overlay = read("app/client/src/components/ReplayDanmakuOverlay.jsx");

  // P1: numeric upstream liveType becomes numeric category; nonmatching search throws.
  const normalizeLive = vm.runInNewContext(cut(live,
    "function normalizeLive(", "function formatStartedAt(") + ";normalizeLive");
  const item = normalizeLive({ liveId: "123", title: "测试直播", member: { name: "成员" }, liveType: 1 });
  const filterBody = cut(live, "    return lives.filter(", "  }, [lives, searchQuery]);");
  assert.throws(() => vm.runInNewContext("(function(){" + filterBody + "})()", {
    lives: [item], q: "zzzz-no-match",
  }), e => e.name === "TypeError" && /category.toLowerCase/.test(e.message));
  console.log("CONFIRMED 1: actual PublicLive filter throws TypeError for liveType=1 + nonmatching search");

  // P2: game/AI/absent type enters an undefined-variable branch.
  const category = vm.runInNewContext(cut(replay,
    "function replayCategory(", "function normalizeReplay(") + ";replayCategory", { TEXT: { zh: {} } });
  assert.equal(category({ liveType: 1 }), "视频直播");
  assert.equal(category({ liveType: 2 }), "电台直播");
  for (const liveType of [5, 6, null]) {
    assert.throws(() => category({ liveType }), e => e.name === "ReferenceError" && /text is not defined/.test(e.message));
  }
  console.log("CONFIRMED 2: replay types 5/6/null throw ReferenceError: text is not defined");

  // P2: enable -> disable while GET pending -> enable leaves status=loading forever.
  const overlayBody = cut(overlay, "    if (!enabled || !normalizedReplayId", "  }, [enabled, normalizedReplayId, available]");
  let overlayStatus = "idle", resolveDanmaku;
  const overlayEnv = {
    enabled: true, normalizedReplayId: "1", available: true, status: overlayStatus,
    setStatus: value => { overlayStatus = value; }, setRecords() {},
    publicApi: { get: () => new Promise(resolve => { resolveDanmaku = resolve; }) },
    payload: r => r, normalizeReplayDanmakuList: r => r,
  };
  const cleanup = vm.runInNewContext("(function(){" + overlayBody + "})()", overlayEnv);
  cleanup(); // enabled=false causes React cleanup of the old effect.
  vm.runInNewContext("(function(){" + overlayBody + "})()", { ...overlayEnv, enabled: false, status: overlayStatus });
  resolveDanmaku({ list: [{ text: "hello" }] });
  await Promise.resolve();
  let newRequests = 0;
  vm.runInNewContext("(function(){" + overlayBody + "})()", {
    ...overlayEnv, status: overlayStatus,
    publicApi: { get: () => { newRequests++; return Promise.resolve({ list: [] }); } },
  });
  assert.equal(overlayStatus, "loading");
  assert.equal(newRequests, 0);
  console.log("CONFIRMED 3: replay danmaku toggle race remains loading with zero replacement requests");

  // P2: route cleanup cannot cancel a pending POST; its continuation resurrects polling.
  const downloadBody = cut(replay, "    if (!selected?.replayId", "  }, [downloadState.status, selected]");
  let resolvePost, scheduled = [], downloadState;
  const downloadEnv = {
    selected: { replayId: "A" }, downloadState: { status: "idle" }, downloadTimerRef: { current: null },
    window: { clearTimeout() { scheduled = []; }, setTimeout(fn) { scheduled.push(fn); return 1; }, location: {} },
    setDownloadState(value) { downloadState = value; },
    publicApi: { post: () => new Promise(resolve => { resolvePost = resolve; }), get: async () => ({ status: "preparing", progress: 5 }) },
    payload: r => r,
  };
  const downloading = vm.runInNewContext("(async function(){" + downloadBody + "})()", downloadEnv);
  // Exact two operations in the replayId change effect, lines 368-369.
  downloadEnv.window.clearTimeout(downloadEnv.downloadTimerRef.current);
  downloadEnv.setDownloadState({ status: "idle", progress: 0, error: "" });
  resolvePost();
  await downloading;
  assert.equal(downloadState.status, "preparing");
  assert.equal(scheduled.length, 1);
  console.log("CONFIRMED 4: canceled replay-A download resurrects timer and overwrites replay-B state");

  // P2: close before await getLive settles is missed; subscriber and heartbeat leak.
  const server = read("app/server/routes/public.js");
  const routeStart = server.indexOf('router.get("/live/:liveId/danmaku"');
  assert(routeStart >= 0);
  const sseBody = cut(server.slice(routeStart), "  let unsubscribe = null;", "\n});");
  const req = new EventEmitter(); req.params = { liveId: "123" };
  let resolveLive, subscriptions = 0, intervals = 0;
  const response = { writableEnded: false, writeHead() {}, flushHeaders() {}, write() {} };
  const sse = vm.runInNewContext("(async function(req,res){" + sseBody + "})", {
    numericQuery: v => v,
    liveService: { getLive: () => new Promise(resolve => { resolveLive = resolve; }) },
    danmakuManager: { subscribe() { subscriptions++; return () => { subscriptions--; }; } },
    setInterval() { intervals++; return { unref() {} }; }, clearInterval() { intervals--; },
  })(req, response);
  req.emit("close"); // Visitor navigates away during the upstream metadata await.
  resolveLive({ roomId: "456" });
  await sse;
  assert.equal(subscriptions, 1);
  assert.equal(intervals, 1);
  assert.equal(req.listenerCount("close"), 1);
  console.log("CONFIRMED 5: disconnected SSE request still owns subscriber=1, heartbeat=1, late close listener=1");
  console.log("All five targeted read-only probes passed (i.e. confirmed the audited defects).");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
