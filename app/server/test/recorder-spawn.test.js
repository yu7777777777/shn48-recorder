"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-real-recorder-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const live = require("../modules/pocket48/live");
const recorder = require("../modules/pocket48/recorder");
const manager = require("../modules/recorder/manager");
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
const available = !spawnSync(ffmpeg, ["-version"]).error && !spawnSync(ffprobe, ["-version"]).error;
test.after(async () => { await recorder.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
test("real recorder launches ffmpeg, writes playable media and finalizes", { skip: !available }, async (t) => {
  const source = path.join(root, "fixture.flv");
  const made = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
  assert.equal(made.status, 0, made.stderr?.toString());
  t.mock.method(live, "getLive", async id => ({ live: { liveId: String(id), title: "fixture", member: { id: "6431", name: "测试成员" } }, streamUrl: source }));
  let timer;
  const finished = new Promise((resolve, reject) => {
    const off = recorder.onFinalized(rec => { clearTimeout(timer); off(); resolve(rec); });
    timer = setTimeout(() => { off(); reject(new Error("real ffmpeg did not finalize")); }, 15000);
  });
  try {
    const started = await recorder.start("987654321", { autoMonitorId: "6431" });
    const rec = await finished;
    assert.equal(rec.id, started.recordingId);
    assert.equal(rec.claimKey, "987654321");
    assert.equal(rec.autoMonitorId, "6431");
    assert.equal(rec.status, "waiting_merge", rec.error);
    assert.ok(fs.statSync(rec.filePath).size > 0);
    assert.equal(recorder.listActive().length, 0);
    const probed = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", rec.filePath]);
    assert.equal(probed.status, 0, probed.stderr?.toString());
    assert.ok(Number(JSON.parse(probed.stdout.toString()).format.duration) >= 1);
    assert.equal(manager.getRecording(rec.id).status, "waiting_merge");
  } finally { clearTimeout(timer); }
});
