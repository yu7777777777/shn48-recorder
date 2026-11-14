"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-search-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const store = require("../lib/store");
const search = require("../modules/analysis/search");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function archived(name, liveId, extra = {}) {
  const file = path.join(process.env.RECORDINGS_DIR, `${name}.mp4`);
  fs.writeFileSync(file, "x");
  return manager.addRecording({ status: "done", filePath: file, mediaType: "video", source: "pocket48", liveId, memberName: extra.memberName || "成员甲", title: extra.title || `${name} 的直播`, ...extra });
}

function seedAnalysis(id, segments) {
  store.atomicWrite(store.filePath(`analysis_${id}`), { segments, chapters: [], highlights: [] });
}

test("a keyword returns the session, member, timestamp and text across archives", () => {
  const a = archived("s1", "1001");
  const b = archived("s2", "1002", { memberName: "成员乙" });
  seedAnalysis(a.id, [
    { start: 10, end: 12, text: "今天谢谢大家的陪伴" },
    { start: 30, end: 33, text: "下次直播再聊" },
  ]);
  seedAnalysis(b.id, [{ start: 5, end: 7, text: "谢谢大家的礼物" }]);

  const result = search.search("谢谢大家");
  assert.equal(result.recordingsHit, 2);
  assert.equal(result.totalMatches, 2);
  const hitA = result.results.find(row => row.recordingId === a.id);
  assert.equal(hitA.memberName, "成员甲");
  assert.equal(hitA.matches[0].start, 10);
  assert.equal(hitA.matches[0].text, "今天谢谢大家的陪伴");
  const hitB = result.results.find(row => row.recordingId === b.id);
  assert.equal(hitB.memberName, "成员乙");
});

test("member filter, deleted archives, clips and backup snapshots are excluded", () => {
  const c = archived("s3", "1003", { memberName: "成员丙" });
  seedAnalysis(c.id, [{ start: 1, end: 2, text: "官宣一下" }]);
  const deleted = archived("s4", "1004");
  seedAnalysis(deleted.id, [{ start: 1, end: 2, text: "官宣一下" }]);
  manager.updateRecording(deleted.id, { status: "deleted" });
  const clip = manager.addRecording({ status: "done", source: "clip", parentRecordingId: c.id, filePath: path.join(process.env.RECORDINGS_DIR, "clip.mp4") });
  seedAnalysis(clip.id, [{ start: 1, end: 2, text: "官宣一下" }]);
  // A backup snapshot must never surface in search results.
  fs.writeFileSync(path.join(root, "data", `analysis_${c.id}_before_correction.json`), JSON.stringify({ segments: [{ start: 1, end: 2, text: "被改掉的官宣" }] }));

  const everything = search.search("官宣");
  assert.equal(everything.recordingsHit, 1);
  assert.equal(everything.results[0].recordingId, c.id);

  assert.equal(search.search("官宣", { member: "成员乙" }).recordingsHit, 0, "member filter narrows results");
  assert.throws(() => search.search("   "), /关键词/);
});

test("mtime cache keeps repeated queries correct after the subtitle file changes", () => {
  const d = archived("s5", "1005");
  seedAnalysis(d.id, [{ start: 0, end: 1, text: "第一版内容" }]);
  assert.equal(search.search("第一版内容").recordingsHit, 1);
  seedAnalysis(d.id, [{ start: 0, end: 1, text: "第二版内容" }]);
  assert.equal(search.search("第一版内容").recordingsHit, 0, "stale cache must not shadow updated subtitles");
  assert.equal(search.search("第二版内容").recordingsHit, 1);
});

test("per-recording match cap bounds the result size", () => {
  const e = archived("s6", "1006");
  seedAnalysis(e.id, Array.from({ length: 50 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, text: `重复关键词 ${index}` })));
  const result = search.search("重复关键词");
  assert.equal(result.results[0].matches.length, 20, "MAX_MATCHES_PER_RECORDING");
});
