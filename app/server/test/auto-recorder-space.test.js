"use strict";

// Regression tests for the 2026-10-25 silent recording gap and the policy change
// that followed it. The original guard refused every start below a flat 10 GiB
// free-space line and logged nothing, so a 40 GiB server stopped recording for a
// day and a half while lives came and went. The rule must now answer the real
// question — "can this recording finish?" — and reclaim space before refusing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-autorec-space-"));
process.env.DATA_DIR = testDataDir;

const autoRecorder = require("../modules/pocket48/auto-recorder");

const GiB = 1024 ** 3;
// Default policy: floor 2 GiB + measured bitrate x 3 assumed hours. With the
// 0.2 GiB/h floor that is 2.6 GiB; the tests below pin an explicit assumption so
// they never depend on whatever recordings happen to exist in the data dir.
const ASSUMED = { assumedBytesPerHour: 1 * GiB, assumedLiveHours: 3 }; // => 2 + 3 = 5 GiB

function buildService({ freeGiB, lives = [], statfsThrows = false, recorder = {}, manager = {} }) {
  const starts = [];
  const statfsCalls = [];
  // Mirror the real recorder: a started recording is active until it is stopped,
  // otherwise the concurrency count stays 0 and every poll restarts the same live.
  const active = new Map();
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: lives }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        starts.push({ liveId, ...options });
        const item = { recordingId: `rec-${liveId}`, liveId, ...options };
        active.set(item.recordingId, item);
        return item;
      },
      stop: async (recordingId) => { active.delete(recordingId); },
      onFinalized: () => {},
      ...recorder,
    },
    uploads: { enqueueRecording() {} },
    // Always inject the history reader: left to the real module it returns whatever
    // recordings the host happens to have, which makes the estimate unpredictable.
    manager: { getRecordings: () => [], getQueue: () => [], ...manager },
    statfs: (dir) => {
      statfsCalls.push(dir);
      if (statfsThrows) throw new Error("ENOENT");
      return { bavail: Math.floor(freeGiB * GiB), bsize: 1 };
    },
    manager,
  });
  return { service, starts, statfsCalls };
}

const memberLives = [
  { liveId: "live-low", member: { id: "m1" } },
  { liveId: "live-two", member: { id: "m2" } },
];
const twoMembers = [{ memberId: "m1" }, { memberId: "m2" }];

test("a small disk still records when reclaim can make room for the estimated live", async () => {
  // This is the exact case the old flat 10 GiB rule refused outright: 3 GiB free on
  // a small volume. Reclaim is what makes the difference, so stub it to free room.
  const realReclaim = require("../modules/recorder/retention").reclaimNow;
  const { service, starts } = buildService({ freeGiB: 3, lives: [memberLives[0]] });
  let askedFor = null;
  require("../modules/recorder/retention").reclaimNow = async (_dir, opts) => {
    askedFor = opts?.targetBytes;
    return { freed: 3 * GiB, files: 2, free: 6 * GiB };
  };
  try {
    service.setConfig({ enabled: true, maxConcurrent: 5, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
    await service.poll();
  } finally {
    require("../modules/recorder/retention").reclaimNow = realReclaim;
  }

  assert.equal(askedFor, 5 * GiB, "reclaim is asked for exactly what the estimate needs");
  assert.deepEqual(starts.map((s) => s.liveId), ["live-low"], "after reclaim the 3 GiB volume records");
  assert.equal(service.getStatus().recordingStatus.requiredGiB, 5);
  service.stop();
});

test("space above the floor is sufficient once it covers the estimated live", async () => {
  const { service, starts } = buildService({ freeGiB: 6, lives: [memberLives[0]] });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
  await service.poll();

  assert.deepEqual(starts.map((s) => s.liveId), ["live-low"], "6 GiB free covers the 5 GiB estimate");
  assert.equal(service.getStatus().blocked, undefined);
  assert.equal(service.getStatus().recordingStatus.hasSpace, true);
  service.stop();
});

test("a live is refused and reported when nothing can be reclaimed", async () => {
  // Reclaim reads the real recordings tree; point it at an empty temp directory so
  // this test proves the refuse-and-report path rather than the reclaim path.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-autorec-empty-"));
  const realRecorder = require("../modules/pocket48/recorder");
  const original = realRecorder._internals.recordingsDir;
  realRecorder._internals.recordingsDir = () => emptyDir;
  let service, starts;
  try {
    ({ service, starts } = buildService({ freeGiB: 1, lives: memberLives }));
    service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: twoMembers });
    await service.poll();
  } finally {
    realRecorder._internals.recordingsDir = original;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  assert.deepEqual(starts, [], "below the absolute floor no recording may start");
  const status = service.getStatus();
  assert.equal(status.blocked?.reason, "disk_space");
  assert.equal(status.blocked.requiredGiB, 5);
  assert.equal(status.blocked.waiting, 2);
  assert.ok(status.blocked.message.includes("磁盘"));
  service.stop();
});

test("the block is cleared and recording resumes once space returns", async () => {
  let freeGiB = 1;
  const starts = [];
  const active = new Map();
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: memberLives }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        starts.push(liveId);
        const item = { recordingId: `rec-${liveId}`, liveId, ...options };
        active.set(item.recordingId, item);
        return item;
      },
      stop: async (recordingId) => { active.delete(recordingId); },
      onFinalized: () => {},
    },
    uploads: { enqueueRecording() {} },
    manager: { getRecordings: () => [], getQueue: () => [] },
    statfs: () => ({ bavail: Math.floor(freeGiB * GiB), bsize: 1 }),
  });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, maxConcurrent: 5, members: twoMembers });

  await service.poll();
  assert.equal(service.getStatus().blocked.reason, "disk_space");
  assert.deepEqual(starts, []);

  freeGiB = 20;
  await service.poll();
  assert.equal(service.getStatus().blocked, undefined, "block lifts as soon as space is available");
  assert.deepEqual(starts.sort(), ["live-low", "live-two"]);
  service.stop();
});

test("a failing space probe is reported as its own reason, not as a full disk", async () => {
  const { service, starts } = buildService({ freeGiB: 0, lives: memberLives, statfsThrows: true });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
  await service.poll();

  assert.deepEqual(starts, []);
  const status = service.getStatus();
  assert.equal(status.blocked?.reason, "space_check");
  assert.equal(status.recordingStatus.freeGiB, null);
  assert.equal(status.recordingStatus.hasSpace, false);
  service.stop();
});

test("the space probe measures the directory recordings are actually written to", async () => {
  const { service, statfsCalls } = buildService({ freeGiB: 50 });
  service.setConfig({ enabled: true, members: [{ memberId: "m1" }] });
  await service.poll();
  assert.ok(statfsCalls.length > 0);
  for (const dir of statfsCalls) assert.equal(dir, testDataDir);
  service.stop();
});

test("the capacity limit is reported separately and does not masquerade as a disk problem", async () => {
  const { service, starts } = buildService({ freeGiB: 50, lives: memberLives });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, maxConcurrent: 1, members: twoMembers });
  await service.poll();

  // One recording proceeds under the quota; the other is reported as waiting.
  assert.equal(starts.length, 1);
  const status = service.getStatus();
  assert.equal(status.blocked, undefined, "capacity alone is not a disk block");
  assert.equal(status.capacityRefused?.reason, "capacity");
  assert.equal(status.capacityRefused.maxConcurrent, 1);
  service.stop();
});

test("a blocked state is cleared when the operator disables automatic recording", async () => {
  const { service } = buildService({ freeGiB: 1, lives: memberLives });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
  await service.poll();
  assert.equal(service.getStatus().blocked.reason, "disk_space");

  service.setConfig({ enabled: false });
  service.clearBlocked();
  assert.equal(service.getStatus().blocked, undefined);
  service.stop();
});

test("the block is reported once per edge so a 30s poll cannot flood the log", async () => {
  const { service } = buildService({ freeGiB: 1, lives: memberLives });
  service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
  await service.poll();

  const originals = { error: console.error, log: console.log };
  const lines = [];
  console.error = (msg) => lines.push(String(msg));
  console.log = (msg) => lines.push(String(msg));
  try {
    await service.poll();
    await service.poll();
  } finally {
    console.error = originals.error;
    console.log = originals.log;
  }
  assert.deepEqual(lines, [], "an unchanged block must not be logged repeatedly");
  service.stop();
});

test("the default policy no longer demands a flat 10 GiB", () => {
  const config = autoRecorder._internals.normalizeConfig({});
  assert.equal(config.minFreeGiB, 2, "default floor is 2 GiB, not 10");
  assert.equal(config.assumedBytesPerHour, 0, "0 means measure the real bitrate");
  assert.equal(config.assumedLiveHours, 3);
});

test("the goal is measured from past recordings, not a fixed constant", async () => {
  const recording = (size, startedAt, endedAt) => ({ id: `r-${startedAt}`, size, startedAt, endedAt });
  const { service } = buildService({
    freeGiB: 50,
    manager: {
      getRecordings: () => [
        // 1 GiB over exactly one hour.
        recording(1 * GiB, "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
        // Too short to trust: ignored.
        recording(9 * GiB, "2026-10-20T12:00:00Z", "2026-10-20T12:00:30Z"),
      ],
      getQueue: () => [],
    },
  });
  service.setConfig({ enabled: true, minFreeGiB: 2, assumedBytesPerHour: 0, assumedLiveHours: 3 });
  const status = service.getStatus();
  assert.equal(status.recordingStatus.bytesPerHourGiB, 1, "one hour of 1 GiB data measures as 1 GiB/h");
  assert.equal(status.recordingStatus.requiredGiB, 5, "2 GiB floor + 1 GiB/h x 3 h");
  service.stop();
});

test("an explicit bitrate assumption overrides measurement", async () => {
  const { service } = buildService({
    freeGiB: 50,
    manager: { getRecordings: () => [{ id: "r", size: 10 * GiB, startedAt: "2026-10-20T10:00:00Z", endedAt: "2026-10-20T11:00:00Z" }], getQueue: () => [] },
  });
  service.setConfig({ enabled: true, minFreeGiB: 2, assumedBytesPerHour: 2 * GiB, assumedLiveHours: 2 });
  assert.equal(service.getStatus().recordingStatus.requiredGiB, 6, "2 GiB floor + 2 GiB/h x 2 h");
  service.stop();
});

test("low space is reclaimed from fragments before a start is refused", async () => {
  // A real recordings tree with one reclaimable cache file. Free space as reported
  // is below the estimate, so the recorder must try to free room and then start.
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-autorec-tree-"));
  const cacheDir = path.join(recordingsRoot, ".official-replays", "1320546015452663808");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "complete.json"), "{}");
  fs.writeFileSync(path.join(cacheDir, "verified.mp4"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(recordingsRoot, "loose.flv"), Buffer.alloc(1024));

  const realRecorder = require("../modules/pocket48/recorder");
  const realStorage = require("../modules/recorder/storage");
  const realManager = require("../modules/recorder/manager");
  const originals = {
    recordingsDir: realRecorder._internals.recordingsDir,
    inventory: realStorage.inventory,
    getRecordings: realManager.getRecordings,
    getQueue: realManager.getQueue,
  };
  realRecorder._internals.recordingsDir = () => recordingsRoot;
  realStorage.inventory = () => ({
    files: [
      { filePath: path.join(cacheDir, "verified.mp4"), size: 2048, kind: "untracked", locked: false },
      { filePath: path.join(recordingsRoot, "loose.flv"), size: 1024, kind: "untracked", locked: false },
    ],
  });
  realManager.getRecordings = () => [];
  realManager.getQueue = () => [];

  let freeGiB = 1;
  const starts = [];
  const active = new Map();
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: [memberLives[0]] }) },
    recorder: {
      _internals: { recordingsDir: () => recordingsRoot },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        starts.push(liveId);
        const item = { recordingId: `rec-${liveId}`, liveId, ...options };
        active.set(item.recordingId, item);
        return item;
      },
      stop: async (id) => { active.delete(id); },
      onFinalized: () => {},
    },
    uploads: { enqueueRecording() {} },
    // Each reclaim frees the "disk" enough for the start to proceed.
    statfs: () => ({ bavail: Math.floor(freeGiB * GiB), bsize: 1 }),
  });
  try {
    service.setConfig({ enabled: true, minFreeGiB: 2, ...ASSUMED, members: [{ memberId: "m1" }] });
    // Simulate reclaim freeing space by reporting more free space afterwards.
    const realReclaim = require("../modules/recorder/retention").reclaimNow;
    require("../modules/recorder/retention").reclaimNow = async () => { freeGiB = 20; return { freed: 3072, files: 2, free: 20 * GiB }; };
    try {
      await service.poll();
    } finally {
      require("../modules/recorder/retention").reclaimNow = realReclaim;
    }
  } finally {
    realRecorder._internals.recordingsDir = originals.recordingsDir;
    realStorage.inventory = originals.inventory;
    realManager.getRecordings = originals.getRecordings;
    realManager.getQueue = originals.getQueue;
    fs.rmSync(recordingsRoot, { recursive: true, force: true });
  }

  assert.deepEqual(starts, ["live-low"], "once reclaim frees room the live starts");
  assert.equal(service.getStatus().blocked, undefined);
  service.stop();
});

test("reclaimNow deletes unlocked cache files and keeps archive main files", async () => {
  const retention = require("../modules/recorder/retention");
  const manager = require("../modules/recorder/manager");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-reclaim-"));
  const cache = path.join(root, ".official-replays", "123");
  fs.mkdirSync(cache, { recursive: true });
  const cacheFile = path.join(cache, "verified.mp4");
  const mainFile = path.join(root, "keep.mp4");
  fs.writeFileSync(cacheFile, Buffer.alloc(4096));
  fs.writeFileSync(mainFile, Buffer.alloc(4096));

  const originals = { getRecordings: manager.getRecordings, getQueue: manager.getQueue };
  manager.getRecordings = () => [];
  manager.getQueue = () => [];
  try {
    const result = await retention.reclaimNow(root, {
      targetBytes: 20_000,
      // A tiny free space reported by the probe; each deleted file adds its size.
      statfs: () => ({ bavail: 0, bsize: 1 }),
      inventory: () => [
        { filePath: cacheFile, size: 4096, kind: "untracked", locked: false },
        { filePath: mainFile, size: 4096, kind: "main", locked: false },
      ],
    });
    assert.ok(result.files >= 1, "at least the cache file is reclaimed");
    assert.equal(fs.existsSync(cacheFile), false, "unlocked cache is deleted");
    assert.equal(fs.existsSync(mainFile), true, "archive main files are never reclaimed here");
  } finally {
    manager.getRecordings = originals.getRecordings;
    manager.getQueue = originals.getQueue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
