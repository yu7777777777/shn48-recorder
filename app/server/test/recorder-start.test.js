"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const cp = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-recorder-start-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
let spawned = [];
const spawnMock = test.mock.method(cp, "spawn", (binary, args) => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() { setImmediate(() => child.emit("close", 0, null)); } };
  child.kill = () => child.emit("close", 0, "SIGTERM");
  fs.writeFileSync(args.at(-1), "recorded-media");
  spawned.push({ binary, args, child });
  return child;
});
const live = require("../modules/pocket48/live");
const manager = require("../modules/recorder/manager");
const recorder = require("../modules/pocket48/recorder");
const { createAutoRecorder } = require("../modules/pocket48/auto-recorder");
function details(id) {
  return { live: { liveId: String(id), title: "测试直播", member: { id: "6431", name: "测试成员" } }, streamUrl: "https://example.invalid/live.flv" };
}
test.afterEach(async () => { await recorder.stopAll(); });
test.after(() => { spawnMock.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); });

test("manual start reaches ffmpeg and persists a normalized live claim", async (t) => {
  t.mock.method(live, "getLive", async id => details(id));
  const count = spawned.length;
  const started = await recorder.start(12345);
  assert.ok(started.recordingId);
  assert.equal(started.liveId, "12345");
  assert.equal(spawned.length, count + 1);
  const saved = manager.getRecording(started.recordingId);
  assert.equal(saved.claimKey, "12345");
  assert.equal(saved.status, "recording");
  assert.equal(recorder.listActive().length, 1);
});

test("automatic poll uses the real recorder start path and tracks the child", async (t) => {
  t.mock.method(live, "getLive", async id => details(id));
  const auto = createAutoRecorder({
    live: { listLives: async () => ({ list: [{ liveId: "auto-1", member: { id: "6431" } }] }) },
    recorder,
    uploads: { setRecordingActive() {} },
    statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
  });
  try {
    auto.setConfig({ enabled: true, members: [{ memberId: "6431" }] });
    await auto.poll();
    const status = auto.getStatus();
    assert.equal(status.activeCount, 1);
    assert.equal(status.trackedLives[0].liveId, "auto-1");
    const saved = manager.getRecording(status.trackedLives[0].recordingId);
    assert.equal(saved.claimKey, "auto-1");
    assert.equal(saved.autoMonitorId, "6431");
  } finally { auto.stop(); }
});

test("concurrent starts share the successful launch result and spawn once", async (t) => {
  let finish;
  t.mock.method(live, "getLive", id => new Promise(resolve => { finish = () => resolve(details(id)); }));
  const count = spawned.length;
  const first = recorder.start("concurrent-1");
  const second = recorder.start("concurrent-1");
  finish();
  const results = await Promise.all([first, second]);
  assert.ok(results[0]?.recordingId);
  assert.equal(results[1]?.recordingId, results[0].recordingId);
  assert.equal(spawned.length, count + 1);
  const again = await recorder.start("concurrent-1");
  assert.equal(again.recordingId, results[0].recordingId);
  assert.equal(spawned.length, count + 1);
});

test("concurrent failed starts share rejection, release the claim and permit retry", async (t) => {
  let fail;
  const lookup = t.mock.method(live, "getLive", () => new Promise((_, reject) => { fail = reject; }));
  const first = recorder.start("retry-1");
  const second = recorder.start("retry-1");
  fail(new Error("temporary lookup failure"));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(r => r.status), ["rejected", "rejected"]);
  assert.ok(results.every(r => r.reason.message === "temporary lookup failure"));
  lookup.mock.mockImplementation(async id => details(id));
  const retried = await recorder.start("retry-1");
  assert.ok(retried.recordingId);
  assert.equal(manager.getRecording(retried.recordingId).claimKey, "retry-1");
});
