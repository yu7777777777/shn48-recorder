"use strict";
// Automatic replay watch, ported from RuokeZhang/pocket48-summarizer
// (MIT, commit d5f45afeef1766e16525393e1beb13d24b2452ba, replay_watch.py).
//
// Upstream polls one configured member at most once a day, only considers replays
// started after the watch was enabled, refuses a replay whose member does not
// match the target, and remembers the last error instead of retrying in a loop.
// This port keeps those rules and reuses the existing share intake so an
// imported replay goes through exactly the same gate a pasted link does.
const fs = require("fs");
const path = require("path");
const store = require("../../lib/store");
const replay = require("./replay");
const intake = require("../analysis/replay-intake");

const DAY_MS = 86_400_000;
const FILE = path.join(process.env.POCKET48_DATA_DIR || process.env.DATA_DIR || path.dirname(require("./api")._internals.TOKEN_PATH), "replay-watch.json");
const SHARE = (liveId) => `https://h5.48.cn/2019appshare/memberLiveShare/index.html?id=${liveId}`;

const EMPTY = Object.freeze({
  enabled: false, memberId: "", memberName: "", enabledAt: null,
  lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: "", lastQueued: 0,
});
let state = { ...EMPTY };
try { state = { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch {}

let busy = false;
let timer = null;
let runNow = () => replay.listReplays({ userId: state.memberId });

function save() { store.atomicWrite(FILE, state); }
function status(now = Date.now()) {
  const nextAt = state.enabled && state.lastAttemptAt
    ? new Date(Date.parse(state.lastAttemptAt) + DAY_MS).toISOString()
    : null;
  return { ...state, running: busy, nextAt, due: Boolean(state.enabled) && (!state.lastAttemptAt || now - Date.parse(state.lastAttemptAt) >= DAY_MS) };
}

function configure(value = {}) {
  if (typeof value.enabled !== "boolean") throw Object.assign(new Error("自动回放巡检开关无效"), { status: 400 });
  const memberId = String(value.memberId ?? state.memberId ?? "").trim();
  if (value.enabled && !/^\d{1,30}$/.test(memberId)) throw Object.assign(new Error("请填写要巡检的成员 ID"), { status: 400 });
  state = {
    ...state,
    enabled: value.enabled,
    memberId,
    memberName: typeof value.memberName === "string" ? value.memberName.slice(0, 40) : state.memberName,
    // The window starts when the watch is armed, never at the first poll: a member
    // with years of replays must not dump all of them into the import queue.
    enabledAt: value.enabled && !state.enabled ? new Date().toISOString() : state.enabledAt,
    lastErrorCode: value.enabled ? "" : state.lastErrorCode,
  };
  if (!value.enabled) { state.lastAttemptAt = null; state.lastQueued = 0; }
  save();
  return status();
}

// Pure decision step: given the member's replay list, which live ids should be
// imported? Only replays that started inside the window, that really belong to the
// member, that are not archived yet and are not already downloading.
function select(list, { memberId, since, archived = [], active = [] }) {
  const archivedIds = new Set(archived.map(String));
  const activeIds = new Set(active.map(String));
  const picked = [];
  for (const item of Array.isArray(list) ? list : []) {
    const liveId = String(item?.liveId || "");
    if (!/^\d{1,30}$/.test(liveId)) continue;
    if (String(item?.member?.id ?? "") !== String(memberId)) continue;
    const started = Date.parse(item?.startedAt || "");
    if (!Number.isFinite(started) || started < since) continue;
    if (archivedIds.has(liveId) || activeIds.has(liveId)) continue;
    archivedIds.add(liveId);
    picked.push(liveId);
  }
  return picked;
}

// A replay list that cannot be fetched is a real outage: the route surfaces this
// sentence verbatim instead of letting the frontend report a empty "no new replays".
const UPSTREAM_UNREACHABLE = "口袋48回放列表暂时无法访问";
// Contract: resolves to `{ queued: <number>, upstreamError?: string }`. `queued`
// counts imports enqueued by this attempt; `upstreamError` is a human-readable
// Chinese reason set only when the member replay list itself could not be
// fetched (per-replay problems stay in `lastErrorCode` instead). Callers must not
// treat the numeric value as the whole result.
async function tick(now = Date.now(), options = {}) {
  const force = options?.force === true;
  if (!state.enabled || busy) return { queued: 0 };
  if (!force && state.lastAttemptAt && now - Date.parse(state.lastAttemptAt) < DAY_MS) return { queued: 0 };
  busy = true;
  // `force` is the manual "check now" path: it skips the 24h gate and stamps the
  // real clock, never the caller-provided `now`, so a shifted timestamp can no
  // longer postpone the next automatic sweep to tomorrow+1.
  const attemptedAt = force ? Date.now() : now;
  // The attempt is stamped before any network request so a crash cannot turn into
  // a hot loop against Pocket48 on the next boot.
  state.lastAttemptAt = new Date(attemptedAt).toISOString();
  state.lastErrorCode = "";
  save();
  let queued = 0;
  try {
    const since = Date.parse(state.enabledAt || new Date(attemptedAt).toISOString());
    const page = await runNow();
    const liveIds = select(page?.list, {
      memberId: state.memberId,
      since,
      archived: intake._internals.archivedLiveIds(),
      active: intake._internals.activeLiveIds(),
    });
    for (const liveId of liveIds) {
      try {
        const preview = await intake.preview(SHARE(liveId));
        const job = intake.confirm(preview.previewId);
        if (job?.kind === "import") queued += 1;
      } catch (error) {
        // A replay that is not public yet is normal, not an error: keep going and
        // leave lastErrorCode untouched so the operator only ever sees a real,
        // actionable failure for this attempt.
        if (error?.code !== "replay_not_ready") state.lastErrorCode = error?.code || "replay_watch_failed";
      }
    }
    state.lastSuccessAt = new Date().toISOString();
    state.lastQueued = queued;
    save();
    return { queued };
  } catch (error) {
    state.lastErrorCode = error?.code || "pocket48_replay_list_failed";
    save();
    return { queued: 0, upstreamError: UPSTREAM_UNREACHABLE };
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { void tick().catch(() => {}); }, 600_000);
  timer.unref?.();
  void tick().catch(() => {});
}
function stop() { clearInterval(timer); timer = null; }

module.exports = {
  status, configure, tick, start, stop, select,
  _internals: { FILE, SHARE, DAY_MS, setLister: (fn) => { runNow = fn; }, reset: () => { timer = null; } },
};
