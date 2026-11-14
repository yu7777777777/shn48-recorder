"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-highlights-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const store = require("../lib/store");
const clips = require("../modules/recorder/clips");
const highlights = require("../modules/analysis/highlights");

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function archived() {
  const file = path.join(process.env.RECORDINGS_DIR, `h${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(file, "x");
  return manager.addRecording({ status: "done", filePath: file, mediaType: "video", source: "pocket48", liveId: "7001", memberName: "成员甲", title: "高光测试直播" });
}

function seed(id, list) {
  store.atomicWrite(store.filePath(`analysis_${id}`), { segments: [{ start: 0, end: 2, text: "字幕" }], chapters: [], highlights: list });
}

// highlights.js resolves clips.enqueue at call time through the module object,
// so overriding the property intercepts the queue hand-off without ffmpeg.
const clipCalls = [];
const originalEnqueue = clips.enqueue;
test.beforeEach(() => {
  clipCalls.length = 0;
  clips.enqueue = (id, options) => {
    clipCalls.push({ id, options });
    return { id: `clip_${clipCalls.length}`, title: options.title, status: "clip_queued", duration: options.segments.reduce((sum, s) => sum + s.end - s.start, 0) };
  };
});
test.afterEach(() => { clips.enqueue = originalEnqueue; });

test("merged mode enqueues one clip concatenating every highlight", () => {
  const rec = archived();
  seed(rec.id, [
    { start: 10, end: 40, title: "唱歌", summary: "唱了一首歌" },
    { start: 60, end: 90, title: "聊天", summary: "聊了个话题" },
  ]);
  const result = highlights.clip(rec.id, { mode: "merged" });
  assert.equal(result.mode, "merged");
  assert.equal(clipCalls.length, 1);
  assert.equal(clipCalls[0].options.segments.length, 2);
  assert.ok(clipCalls[0].options.title.includes("精彩合集"));
  assert.equal(result.segments, 2);
});

test("separate mode enqueues one clip per highlight and skips too-short ones", () => {
  const rec = archived();
  seed(rec.id, [
    { start: 10, end: 40, title: "唱歌", summary: "" },
    { start: 41, end: 41.5, title: "太短", summary: "" },
    { start: 60, end: 90, title: "聊天", summary: "" },
  ]);
  const result = highlights.clip(rec.id, { mode: "separate" });
  assert.equal(result.mode, "separate");
  assert.equal(result.queued.length, 2);
  assert.equal(result.skippedTooShort, 1);
  assert.equal(clipCalls.length, 2);
  assert.ok(clipCalls[0].options.title.startsWith("唱歌"));
});

test("indexes address positions in the raw highlights array", () => {
  const rec = archived();
  seed(rec.id, [
    { start: 10, end: 40, title: "A", summary: "" },
    { start: 50, end: 80, title: "B", summary: "" },
    { start: 90, end: 120, title: "C", summary: "" },
  ]);
  highlights.clip(rec.id, { mode: "merged", indexes: [2, 0] });
  assert.equal(clipCalls.length, 1);
  assert.deepEqual(clipCalls[0].options.segments.map(segment => Math.round(segment.start)), [10, 90], "sorted by time, raw indexes honoured");
});

test("validation: missing analysis, bad indexes, out-of-range values", () => {
  const rec = archived();
  assert.throws(() => highlights.clip(rec.id, {}), /还没有精彩片段/);
  seed(rec.id, [{ start: 10, end: 40, title: "A", summary: "" }]);
  assert.throws(() => highlights.clip(rec.id, { indexes: [5] }), /序号无效/);
  assert.throws(() => highlights.clip(rec.id, { indexes: [-1] }), /序号无效/);
  assert.throws(() => highlights.clip("rec_missing", {}), /归档不存在/);
  // All-shorter-than-1s selection is refused instead of silently no-op.
  seed(rec.id, [{ start: 10, end: 10.5, title: "短", summary: "" }]);
  assert.throws(() => highlights.clip(rec.id, {}), /不足 1 秒/);
});
