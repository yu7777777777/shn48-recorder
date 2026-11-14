"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-peaks-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const peaks = require("../modules/analysis/danmaku-peaks");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// 密度峰值：把一条 600 秒的时间线里 120-180 秒之间塞满弹幕，其余稀疏。
function line(offsets) { return offsets; }

test("computePeaks finds the dense window and merges adjacent hot buckets", () => {
  const offsets = [];
  for (let t = 120; t < 180; t += 0.5) offsets.push(t);
  for (let t = 0; t < 600; t += 40) offsets.push(t);
  const result = peaks.computePeaks(offsets, 600);
  assert.ok(result.length >= 1);
  assert.ok(result[0].time >= 90 && result[0].time <= 210, "the dense window wins the top peak");
  assert.ok(result.every(peak => Number.isFinite(peak.time) && peak.count > 0));
});

test("quiet rooms and tiny samples return no peaks", () => {
  assert.deepEqual(peaks.computePeaks([], 600), []);
  assert.deepEqual(peaks.computePeaks([1, 2, 3], 600), [], "fewer than 5 offsets is not enough evidence");
  // Perfectly even distribution has no standout moments.
  const even = [];
  for (let t = 0; t < 600; t += 5) even.push(t);
  assert.deepEqual(peaks.computePeaks(even, 600), []);
});

test("fromRecording reads captured room messages and tolerates missing data", () => {
  const file = path.join(process.env.RECORDINGS_DIR, "p1.mp4");
  fs.writeFileSync(file, "x");
  const rec = manager.addRecording({ status: "done", filePath: file, mediaType: "video", source: "pocket48", liveId: "8001" });
  const offsets = [];
  for (let t = 300; t < 400; t += 1) offsets.push(t);
  require("../lib/store").atomicWrite(require("../lib/store").filePath(`voice_messages_${rec.id}`),
    offsets.map(offset => ({ bodys: "哈哈哈哈", offset, senderName: "观众" })));
  const result = peaks.fromRecording(rec.id, 900);
  assert.ok(result.length >= 1);
  assert.ok(result[0].time >= 270 && result[0].time <= 430);
  // Missing messages or missing recordings degrade to empty, never throw.
  assert.deepEqual(peaks.fromRecording("rec_missing", 900), []);
});
