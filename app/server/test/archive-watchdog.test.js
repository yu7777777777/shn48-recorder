"use strict";
// Watchdog for merge child processes and crash-proof recording finalization.
// Real binaries are not needed: hanging children are node processes, and the
// finalize tests inject failures into manager.updateRecording.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-archive-watchdog-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require("../modules/recorder/manager");
const recorder = require("../modules/pocket48/recorder");
const archive = require("../modules/recorder/archive-processor");
test.after(() => { archive.stop(); fs.rmSync(root, { recursive: true, force: true }); });

async function assertProcessGone(pid, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`${what} should have been killed`);
}

test("spawnWithTimeout rejects and kills a hanging child", async () => {
  const pidFile = path.join(root, "hang.pid");
  // The pid file makes the kill observable: the child records itself at startup.
  const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 60000);`;
  let rejection = null;
  try {
    await archive._internals.spawnWithTimeout(process.execPath, ["-e", script], { timeoutMs: 300, timeoutLabel: "测试进程" });
  } catch (error) { rejection = error; }
  assert.ok(rejection, "a hanging child must reject");
  assert.equal(rejection.message, `测试进程超时(${Math.round(300 / 1000)}s)`);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0);
  await assertProcessGone(pid, "hanging child");
});

test("spawnWithTimeout resolves a child that exits in time", async () => {
  const result = await archive._internals.spawnWithTimeout(process.execPath, ["-e", "process.stdout.write('ok')"],
    { timeoutMs: 5000, timeoutLabel: "测试进程", collectStdout: true });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
});

test("spawnWithTimeout rejects with the collected stderr on nonzero exit", async () => {
  await assert.rejects(() => archive._internals.spawnWithTimeout(process.execPath,
    ["-e", "console.error('boom'); process.exit(3)"], {
      timeoutMs: 5000, timeoutLabel: "测试进程", collectStderr: true,
      exitError: (code, stderr) => new Error(stderr.trim() || `code ${code}`),
    }), /boom/);
});

test("probe surfaces the watchdog error when ffprobe never exits", async t => {
  const original = archive._internals.spawnWithTimeout;
  t.after(() => { archive._internals.spawnWithTimeout = original; });
  // A node "ffprobe" would exit at once on the probe arguments, so the injected
  // helper runs the real watchdog against a hanging node child instead, with a
  // short timeout, while probe itself still chooses bin, label and options.
  let captured = null;
  archive._internals.spawnWithTimeout = (bin, args, options) => {
    captured = { bin, args, options };
    return original(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { ...options, timeoutMs: 1000 });
  };
  await assert.rejects(() => archive._internals.probe(path.join(root, "clip.flv")), /媒体探测超时\(1s\)/);
  assert.equal(captured.bin, process.env.FFPROBE_BIN || "ffprobe");
  assert.equal(captured.options.timeoutLabel, "媒体探测");
  assert.equal(captured.options.timeoutMs, archive._internals.PROBE_TIMEOUT_MS);
  assert.equal(captured.options.collectStdout, true);
});

test("probe validates the ffprobe JSON payload", async t => {
  const original = archive._internals.spawnWithTimeout;
  t.after(() => { archive._internals.spawnWithTimeout = original; });
  archive._internals.spawnWithTimeout = async () => ({
    code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264" }], format: { duration: "12.5" } }), stderr: "",
  });
  const info = await archive._internals.probe("ignored.flv");
  assert.equal(info.format.duration, "12.5");
  archive._internals.spawnWithTimeout = async () => ({
    code: 0, stdout: JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "0" } }), stderr: "",
  });
  await assert.rejects(() => archive._internals.probe("ignored.flv"), /录像没有可用的视频或时长/);
});

function fixture(liveId, extra = {}) {
  const base = path.join(process.env.RECORDINGS_DIR, `${liveId}.flv`);
  const recording = manager.addRecording({
    source: "pocket48", liveId, memberId: "6431", memberName: "测试成员", title: liveId, liveTitle: liveId,
    status: "recording", filePath: `${base}.partial`, startedAt: new Date().toISOString(), ...extra,
  });
  const entry = {
    recordingId: recording.id, liveId, title: liveId, memberId: "6431", memberName: "测试成员",
    startedAt: new Date().toISOString(), finalPath: base, partialPath: `${base}.partial`,
    child: null, stderr: "", stopRequested: false, finalized: false,
    lastSize: 0, lastGrowthAt: Date.now(), failureReason: null, healthTimer: null,
  };
  return { recording, entry };
}

async function waitForRetry(condition) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), "persist retry should have completed within five seconds");
}

test("finalize survives one failed index write and persists on the retry", async () => {
  const { recording, entry } = fixture("finalize-flaky");
  fs.writeFileSync(entry.partialPath, "media");
  const original = manager.updateRecording;
  let calls = 0;
  manager.updateRecording = function patched(id, updates) {
    calls += 1;
    if (calls === 1) throw new Error("simulated disk failure");
    return original.call(manager, id, updates);
  };
  let emissions = 0;
  let event = null;
  const off = recorder.onFinalized(item => { emissions += 1; event = item; });
  try {
    let returned = null;
    assert.doesNotThrow(() => { returned = recorder._internals.finalize(entry, 0, null, null); });
    assert.equal(returned.id, recording.id);
    assert.equal(calls, 1, "finalize must not retry synchronously");
    assert.equal(event, null, "the finalized event waits for the persisted state");
    await waitForRetry(() => manager.getRecording(recording.id).status === "waiting_merge");
    assert.equal(calls, 2);
    assert.equal(emissions, 1);
    assert.equal(event.status, "waiting_merge");
    assert.ok(fs.existsSync(entry.finalPath));
    assert.ok(!fs.existsSync(entry.partialPath));
  } finally {
    manager.updateRecording = original;
    off();
  }
});

test("finalize keeps in-memory state when persistence keeps failing", async () => {
  const { recording, entry } = fixture("finalize-dead-disk");
  fs.writeFileSync(entry.partialPath, "media");
  const original = manager.updateRecording;
  manager.updateRecording = function broken() { throw new Error("simulated dead disk"); };
  let emissions = 0;
  let event = null;
  const off = recorder.onFinalized(item => { emissions += 1; event = item; });
  try {
    let returned = null;
    assert.doesNotThrow(() => { returned = recorder._internals.finalize(entry, 0, null, null); });
    assert.equal(returned.status, "recording", "the synchronous return is the rolled-back state");
    await waitForRetry(() => manager.getRecording(recording.id).status === "waiting_merge");
    const current = manager.getRecording(recording.id);
    assert.equal(current.exitCode, 0);
    assert.equal(current.filePath, entry.finalPath);
    assert.equal(emissions, 1);
    assert.equal(event.status, "waiting_merge", "the finalized event still carries the final state");
    assert.ok(fs.existsSync(entry.finalPath));
  } finally {
    manager.updateRecording = original;
    off();
  }
});

test("finalize on the happy path emits immediately and persists waiting_merge", () => {
  const { recording, entry } = fixture("finalize-happy");
  fs.writeFileSync(entry.partialPath, "media");
  let emissions = 0;
  let event = null;
  const off = recorder.onFinalized(item => { emissions += 1; event = item; });
  try {
    const returned = recorder._internals.finalize(entry, 0, null, null);
    assert.equal(returned.status, "waiting_merge");
    assert.equal(emissions, 1);
    assert.equal(event.id, recording.id);
    assert.equal(manager.getRecording(recording.id).status, "waiting_merge");
    assert.ok(fs.existsSync(entry.finalPath));
  } finally { off(); }
});
