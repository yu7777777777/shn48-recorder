"use strict";

// Durable, deliberately small automatic recorder.  A single Pocket48 live-list
// poll covers all selected members, so adding members does not multiply requests.
const fs = require("fs");
const store = require("../../lib/store");
const live = require("./live");
const recorder = require("./recorder");
const uploads = require("../bilibili/queue");
const manager = require("../recorder/manager");
const sse = require("../../lib/sse");

const KEY = "auto_recording";
const GiB = 1024 ** 3;
// Operator-facing text for each blocked start; surfaced through the admin
// status payload so the page can explain a live that was never recorded.
const failureMessages = {
  disk_space: "磁盘可用空间不足，无法保证录完这场直播；清理空间后自动恢复",
  space_check: "无法读取录像目录的剩余空间，自动录制已暂停；请检查录像目录与挂载",
  capacity: "已达自动录制并发上限，新的直播需等待其他录制结束",
};
// This is deliberately a product limit, not a bandwidth recommendation.  The
// operator can choose to favour capture completeness over available bandwidth.
const MAX_CONCURRENCY = 20;

// ---- Disk policy -----------------------------------------------------------
// The old rule was a flat "10 GiB free or do not record". On a 40 GiB volume that
// refused every start for a day and a half while lives came and went, which
// defeats the point of the recorder: a missing recording is much worse than a
// recording that had to be squeezed in.
//
// The rule now asks the actual question: can we finish THIS recording?
//   * defaultMinFreeGiB is only a floor below which even a short live is refused;
//   * requiredBytes is that floor plus what the live is expected to occupy;
//   * the expectation comes from the measured bitrate of past recordings, so a
//     short live needs little and a four-hour concert needs a lot;
//   * when space is short, reclaimable fragments and cache are dropped first.
const DEFAULT_MIN_FREE_GIB = 2;
const DEFAULT_ASSUMED_HOURS = 3;
const DEFAULT_ASSUMED_BYTES_PER_HOUR = 1.5 * GiB;
const MINIMUM_SAFE_FREE_GIB = 0.5;

function now() { return new Date().toISOString(); }
function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function defaults() {
  // A transient empty live-list response must not terminate a long recording.
  // At the default 30s poll interval this gives roughly five minutes of grace.
  return {
    enabled: false, pollMs: 30_000, maxConcurrent: 20,
    missingPollsToStop: 10, reconnectMaxAttempts: 5,
    reconnectBackoffMs: 30_000, missingGraceMs: 5 * 60_000,
    minFreeGiB: DEFAULT_MIN_FREE_GIB, members: [],
  };
}
function normalizeMember(member) {
  if (!member || member.memberId === undefined || member.memberId === null || String(member.memberId).trim() === "") {
    throw new Error("memberId is required");
  }
  return {
    memberId: String(member.memberId),
    memberName: String(member.memberName || "").slice(0, 100),
    // 1 is highest.  Keeping the value on the member makes the saved selection
    // portable and gives ties a stable member-id order.
    priority: number(member.priority, 50, 1, 100),
    enabled: member.enabled !== false,
  };
}
function normalizeConfig(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const members = Array.isArray(input.members) ? input.members.map(normalizeMember) : [];
  const unique = new Map(members.map((member) => [member.memberId, member]));
  return {
    enabled: input.enabled === true,
    pollMs: number(input.pollMs, 30_000, 10_000, 300_000),
    maxConcurrent: number(input.maxConcurrent, defaults().maxConcurrent, 1, MAX_CONCURRENCY),
    missingPollsToStop: number(input.missingPollsToStop, defaults().missingPollsToStop, 1, 20),
    reconnectMaxAttempts: number(input.reconnectMaxAttempts, defaults().reconnectMaxAttempts, 0, 20),
    reconnectBackoffMs: number(input.reconnectBackoffMs, defaults().reconnectBackoffMs, 5_000, 15 * 60_000),
    missingGraceMs: number(input.missingGraceMs, defaults().missingGraceMs, 0, 60 * 60_000),
    minFreeGiB: number(input.minFreeGiB, DEFAULT_MIN_FREE_GIB, 0.5, 1_000),
    // 0 keeps the measured bitrate; a positive value pins an assumption instead.
    assumedBytesPerHour: number(input.assumedBytesPerHour, 0, 0, 64 * GiB),
    assumedLiveHours: Number.isFinite(Number(input.assumedLiveHours))
      ? Math.max(0.5, Math.min(24, Number(input.assumedLiveHours))) : DEFAULT_ASSUMED_HOURS,
    members: [...unique.values()],
  };
}
function liveMemberId(item) {
  const user = item && (item.member || item.userInfo || item.user || {});
  const id = user.id ?? user.userId ?? user.memberId ?? item?.memberId ?? item?.userId;
  return id === undefined || id === null ? "" : String(id);
}

function createAutoRecorder(deps = {}) {
  const api = deps.live || live;
  const recording = deps.recorder || recorder;
  const queue = deps.uploads || uploads;
  const statfs = deps.statfs || fs.statfsSync;
  // Injectable so tests can describe a recording history without touching the
  // host's real data directory.
  const history = deps.manager || manager;
  let saved = store.load(KEY, {});
  let config = normalizeConfig(saved.config || saved);
  // Keep a live-to-recording map across restart: never create duplicate recordings
  // for a live that was already claimed before a process restart.
  let state = saved.state && typeof saved.state === "object" ? saved.state : { lives: {} };
  state.lives = state.lives && typeof state.lives === "object" ? state.lives : {};
  let timer = null;
  let polling = false;

  function save() { store.save(KEY, { config, state }); }
  function activeCount() {
    return recording.listActive().filter((item) => String(state.lives[item.liveId]?.recordingId) === String(item.recordingId)).length;
  }
  // Why the last start attempt did not happen, kept in memory only: it is live
  // operator feedback, not durable state that should survive a restart.
  let blocked = null;
  let capacityRefused = null;
  function setBlocked(reason) {
    const changed = Boolean(reason) !== Boolean(blocked) || (reason && blocked && blocked.reason !== reason.reason);
    blocked = reason || null;
    if (!changed) return;
    // Log on edges only: a poll every 30s must not flood the container log with
    // the same complaint, but entering and leaving the state are both worth one line.
    if (blocked) console.error(`[auto-recorder] not starting: ${blocked.message}`);
    else console.log("[auto-recorder] start gate cleared; recording can resume");
  }
  // Measure the directory ffmpeg actually writes to, not just the configured
  // root: they are only guaranteed to share a filesystem when the deployment
  // mounts both there, and a wrong volume would make the guard meaningless.
  // A failed probe returns null, which callers report as its own block reason
  // rather than silently behaving like "the disk is full".
  function recordingsDir() {
    return recording._internals.recordingsDir();
  }
  function diskFreeBytes() {
    try {
      const info = statfs(recordingsDir());
      const free = Number(info.bavail ?? info.bfree) * Number(info.bsize);
      return Number.isFinite(free) ? free : null;
    } catch (error) {
      console.warn("[auto-recorder] disk space check failed; recording will not start:", error.message);
      return null;
    }
  }
  function diskFreeGiB() {
    const free = diskFreeBytes();
    return free === null ? null : free / GiB;
  }
  // Bytes per hour actually produced by past automatic recordings. Measuring beats
  // guessing: streams vary widely, and a fixed reserve is either far too big on a
  // small disk or too small to finish a long live.
  function observedBytesPerHour() {
    let bytes = 0, seconds = 0;
    for (const rec of history.getRecordings({ includeDeleted: false })) {
      const size = Number(rec.fileSize || rec.size) || 0;
      const ms = Date.parse(rec.endedAt || "") - Date.parse(rec.startedAt || "");
      if (size > 0 && Number.isFinite(ms) && ms > 60_000) { bytes += size; seconds += ms / 1000; }
    }
    return seconds > 0 ? bytes / (seconds / 3600) : 0;
  }
  function bytesPerHour() {
    if (config.assumedBytesPerHour > 0) return config.assumedBytesPerHour;
    const measured = observedBytesPerHour();
    // Never trust a suspiciously small sample: keep a sane floor so a single short
    // test recording cannot make the guard believe a long live costs nothing.
    return Math.max(measured || 0, 0.2 * GiB);
  }
  // What this start needs: an absolute floor (so the process, the merge step and
  // ffmpeg's own buffering always have room) plus room for the expected live.
  function requiredBytes() {
    const floor = Math.max(MINIMUM_SAFE_FREE_GIB, Number(config.minFreeGiB) || 0) * GiB;
    return floor + bytesPerHour() * config.assumedLiveHours;
  }
  // Try to make room instead of refusing outright. Returns the free bytes after
  // the attempt, or null when the probe itself failed.
  async function ensureSpace(needed) {
    const free = diskFreeBytes();
    if (free === null || free >= needed) return free;
    try {
      const retention = require("../recorder/retention");
      if (typeof retention.reclaimNow !== "function") return free;
      const result = await retention.reclaimNow(recordingsDir(), { targetBytes: needed, statfs });
      return Number.isFinite(result?.free) ? result.free : diskFreeBytes();
    } catch (error) {
      console.warn("[auto-recorder] on-demand reclaim failed:", error.message);
      return diskFreeBytes();
    }
  }
  function hasSpace() {
    return diskFreeGiB() !== null && diskFreeBytes() >= requiredBytes();
  }
  function recordingGateActive() {
    return Object.values(state.lives).some((entry) => !entry.finalized);
  }
  function syncUploadGate() {
    if (queue && typeof queue.setRecordingActive === "function") queue.setRecordingActive(recordingGateActive());
  }
  function emit() { syncUploadGate(); sse.broadcast("auto-recording-updated", getStatus()); }
  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    if (config.enabled) timer = setInterval(() => { void poll(); }, config.pollMs);
  }
  function getStatus() {
    const free = diskFreeBytes();
    const needed = requiredBytes();
    return {
      ...config, activeCount: activeCount(), recordingActive: recordingGateActive(),
      // The page previously had no way to tell "nothing is live" apart from "a
      // live was seen and refused", which is how a whole evening went unrecorded.
      recordingStatus: {
        freeGiB: free === null ? null : Number((free / GiB).toFixed(2)),
        minFreeGiB: config.minFreeGiB,
        requiredGiB: Number((needed / GiB).toFixed(2)),
        bytesPerHourGiB: Number((bytesPerHour() / GiB).toFixed(2)),
        assumedLiveHours: config.assumedLiveHours,
        hasSpace: free !== null && free >= needed,
        recordingsDir: recordingsDir(),
      },
      ...(blocked ? { blocked } : {}),
      ...(capacityRefused ? { capacityRefused } : {}),
      trackedLives: Object.values(state.lives).map(({ liveId, memberId, recordingId, missingPolls, startedAt, stopRequested, reconnectPending, reconnectAttempts, nextRetryAt }) => ({
        liveId, memberId, recordingId, missingPolls, startedAt,
        stopRequested: Boolean(stopRequested), reconnectPending: Boolean(reconnectPending),
        reconnectAttempts: Number(reconnectAttempts || 0), nextRetryAt: nextRetryAt || null,
      })), polling,
    };
  }
  function setConfig(next) {
    config = normalizeConfig({ ...config, ...(next || {}) });
    save(); schedule(); emit();
    return getStatus();
  }
  function updateMembers(members) { return setConfig({ members }); }
  function stopTracked(entry) {
    if (!entry.recordingId) return Promise.resolve();
    return recording.stop(entry.recordingId).catch((error) => {
      // A restart leaves no child process to stop; retain the dedupe marker.
      if (error.message !== "Active recording not found") throw error;
    });
  }
  async function poll() {
    if (!config.enabled || polling) return getStatus();
    polling = true;
    try {
      const selected = new Set(config.members.filter((member) => member.enabled).map((member) => member.memberId));
      if (!selected.size) return getStatus();
      const result = await api.listLives(0, "0");
      const seen = new Map((result.list || []).filter((item) => selected.has(liveMemberId(item))).map((item) => [item.liveId, item]));
      // Child processes cannot survive a server restart.  Before trusting persisted
      // de-duplication state, reconcile it with the recorder's in-memory children.
      // This makes an already-live member record again after restart while removing
      // an offline orphan without attempting to stop a non-existent child.
      const activeRecordingIds = new Set(recording.listActive().map((item) => String(item.recordingId)));
      for (const [liveId, entry] of Object.entries(state.lives)) {
        if (!entry.recordingId || activeRecordingIds.has(String(entry.recordingId))) continue;
        // The child can exit because of a transient stream failure. Keep the
        // live claim and let the next poll start a new segment for the same
        // liveId; archive-processor will join the resulting segments.
        entry.recordingId = null;
        entry.reconnectPending = true;
      }
      for (const entry of Object.values(state.lives)) {
        if (seen.has(entry.liveId)) {
          entry.missingPolls = 0;
          entry.missingSince = null;
        }
        else {
          if (!entry.missingSince) entry.missingSince = now();
          entry.missingPolls = Number(entry.missingPolls || 0) + 1;
          const missingFor = Date.now() - Date.parse(entry.missingSince);
          if (entry.missingPolls >= config.missingPollsToStop && missingFor >= config.missingGraceMs && entry.stopRequested && !entry.recordingId) {
            delete state.lives[entry.liveId];
            continue;
          }
          if (entry.missingPolls >= config.missingPollsToStop && missingFor >= config.missingGraceMs && !entry.stopRequested) {
            entry.stopRequested = true;
            await stopTracked(entry);
            if (!entry.recordingId) delete state.lives[entry.liveId];
          }
        }
      }
      const priorityByMember = new Map(config.members.map((member) => [member.memberId, member.priority]));
      const startCandidates = [...seen.values()]
        .filter((item) => {
          const tracked = state.lives[item.liveId];
          if (!tracked) return true;
          if (tracked.stopRequested || tracked.recordingId) return false;
          return !tracked.nextRetryAt || Date.parse(tracked.nextRetryAt) <= Date.now();
        })
        .sort((a, b) => (priorityByMember.get(liveMemberId(a)) || 50) - (priorityByMember.get(liveMemberId(b)) || 50)
          || liveMemberId(a).localeCompare(liveMemberId(b))
          || String(a.liveId).localeCompare(String(b.liveId)));
      for (const item of startCandidates) {
        // Capacity first, so an over-limit server still records within its quota
        // while the operator sees why the extra live waits. The space guard was
        // formerly a silent `continue` here, which turned "disk is full" into a
        // recording that simply never appeared.
        if (activeCount() >= config.maxConcurrent) {
          capacityRefused = {
            reason: "capacity",
            message: failureMessages.capacity,
            waiting: startCandidates.length,
            maxConcurrent: config.maxConcurrent,
            at: now(),
          };
          break;
        }
        // Make room before refusing. A live that is already streaming cannot be
        // replayed later, so reclaiming fragments now beats a clean refusal.
        const needed = requiredBytes();
        const free = await ensureSpace(needed);
        if (free === null) {
          setBlocked({ reason: "space_check", message: failureMessages.space_check, waiting: startCandidates.length, liveId: item.liveId, at: now() });
          break;
        }
        if (free < needed) {
          setBlocked({
            reason: "disk_space",
            message: failureMessages.disk_space,
            freeGiB: Number((free / GiB).toFixed(2)),
            requiredGiB: Number((needed / GiB).toFixed(2)),
            minFreeGiB: config.minFreeGiB,
            waiting: startCandidates.length,
            liveId: item.liveId,
            at: now(),
          });
          break;
        }
        capacityRefused = null;
        setBlocked(null);
        try {
          const memberId = liveMemberId(item);
          const previous = state.lives[item.liveId];
          const reconnectOf = previous?.segmentIds?.at(-1);
          const started = await recording.start(item.liveId, {
            autoMonitorId: memberId,
            ...(reconnectOf ? { reconnectOf } : {}),
          });
          state.lives[item.liveId] = {
            ...(previous || {}),
            liveId: item.liveId,
            memberId,
            recordingId: started.recordingId,
            startedAt: previous?.startedAt || now(),
            lastSegmentStartedAt: now(),
            missingPolls: 0,
            missingSince: null,
            reconnectPending: false,
            stopRequested: false,
            finalized: false,
            nextRetryAt: null,
          };
          syncUploadGate();
        } catch (error) {
          // Keep no failed claim: an online live is a candidate again at the next
          // poll, after higher-priority live streams have had their chance.
          console.error("[auto-recorder] start failed:", error.message);
        }
      }
      save(); emit();
      // A live discovered while blocked may end before the block clears, so the
      // in-loop clear alone would leave a stale banner on screen.
      if (!startCandidates.length) { capacityRefused = null; setBlocked(null); }
      return getStatus();
    } catch (error) {
      console.error("[auto-recorder] poll error:", error.message);
      return getStatus();
    } finally { polling = false; }
  }
  recording.onFinalized((item) => {
    if (!item || !item.autoMonitorId) return;
    const entry = Object.values(state.lives).find((value) => value.recordingId === item.id);
    if (entry) {
      entry.finishedAt = now();
      entry.finalized = true;
      if (!item.manualStop && entry.stopRequested !== true) {
        // Keep the claim alive so the next healthy poll can reconnect the same
        // liveId. The finalized recording remains durable for archive merging.
        entry.segmentIds = [...new Set([...(entry.segmentIds || []), item.id])];
        entry.recordingId = null;
        entry.reconnectAttempts = Number(entry.reconnectAttempts || 0) + 1;
        if (entry.reconnectAttempts > config.reconnectMaxAttempts) {
          entry.reconnectPending = false;
          entry.reconnectExhausted = true;
          entry.stopRequested = true;
        } else {
          entry.reconnectPending = true;
          entry.nextRetryAt = new Date(Date.now() + config.reconnectBackoffMs * Math.min(8, 2 ** (entry.reconnectAttempts - 1))).toISOString();
        }
        save();
        emit();
        return;
      }
    }
    // Recorder close/error handlers can both observe a finalization. Persist a
    // successful enqueue guard so later duplicate events cannot create another draft.
    // The archive processor waits for reconnects, joins all segments, creates
    // one MP4 and only then enqueues the final recording. Uploading here would
    // race that settle window and create one draft per temporary disconnect.
    if (entry) delete state.lives[entry.liveId];
    save(); emit();
  });
  function start() { schedule(); if (config.enabled) void poll(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return {
    getStatus, setConfig, updateMembers, poll, start, stop,
    // Operator chose to disable automation: nothing is "blocked", recordings are
    // simply not expected. Without this a disk warning would outlive the switch
    // that turned the feature off.
    clearBlocked() { if (!config.enabled) { capacityRefused = null; setBlocked(null); } },
    _internals: { hasSpace, diskFreeGiB, state: () => state, normalizeConfig, getBlocked: () => blocked },
  };
}

const service = createAutoRecorder();
module.exports = { ...service, createAutoRecorder, _internals: { normalizeConfig, normalizeMember, liveMemberId, MAX_CONCURRENCY } };
