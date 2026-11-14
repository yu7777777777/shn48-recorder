"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-import-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const replay = require("../modules/pocket48/replay");
const media = require("../modules/recorder/replay-download");
const recorder = require("../modules/pocket48/recorder");
const imports = require("../modules/recorder/replay-import");
const uploadQueue = require("../modules/bilibili/queue");

function waitFor(id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const job = imports.get(id);
      if (["done", "failed"].includes(job?.status)) { clearInterval(timer); resolve(job); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error("导入任务超时")); }
    }, 5);
  });
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("manual replay import archives a verified official replay and queues draft after download", async () => {
  const oldGet = replay.getReplay;
  const oldFind = replay.findReplayMetadata;
  const oldDownload = media.downloadShared;
  const oldActive = recorder.listActive;
  const liveId = "990001";
  const filePath = path.join(process.env.RECORDINGS_DIR, ".official-replays", liveId, "verified.mp4");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "verified-official-replay");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  replay.getReplay = async () => ({ replay: { liveId, title: "官方回放", startedAt: "2026-09-30T02:00:00.000Z", member: { id: "100", name: "测试成员" }, cover: "" }, streamUrl: "https://example.test/replay.m3u8" });
  replay.findReplayMetadata = async () => ({ liveId, durationSeconds: 12, title: "官方回放", startedAt: "2026-09-30T02:00:00.000Z", member: { id: "100", name: "测试成员" } });
  media.downloadShared = async ({ onProgress }) => { onProgress({ completed: 1, total: 1 }); onProgress({ completed: 1, total: 1, verifying: true }); return { liveId, filePath, durationSeconds: 12, size: fs.statSync(filePath).size, sha256, verification: "full", streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] }; };
  recorder.listActive = () => [];
  try {
    const queued = imports.enqueue({ liveId, memberId: "100", autoUpload: true });
    const result = await waitFor(queued.id);
    assert.equal(result.status, "done");
    assert.equal(result.progress, 100);
    assert.equal(result.uploadQueued, true);
    const recording = manager.getRecording(result.recordingId);
    assert.equal(recording.liveId, liveId);
    assert.equal(recording.archiveOrigin, "official_replay");
    assert.equal(recording.replayRecovery.status, "replaced");
    assert.equal(manager.getQueue().filter(item => item.recordingId === recording.id).length, 1);
    assert.equal(manager.getQueue()[0].fileSha256, sha256);
  } finally {
    replay.getReplay = oldGet; replay.findReplayMetadata = oldFind; media.downloadShared = oldDownload; recorder.listActive = oldActive;
  }
});

test("an import without member metadata takes them from the replay list, not today's date", async () => {
  // Regression for the 2026-10-25 backfill: the single-replay endpoint returned an
  // empty member object and no startedAt, so five archives were titled
  // "2026-10-26-Pocket48-..." for lives that aired on 2026-10-25.
  const oldGet = replay.getReplay;
  const oldList = replay.listReplays;
  const oldDownload = media.downloadShared;
  const oldActive = recorder.listActive;
  const liveId = "990004";
  const filePath = path.join(process.env.RECORDINGS_DIR, ".official-replays", liveId, "verified.mp4");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "verified-official-replay");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  // Exactly what upstream returned during the incident: no member, no start time.
  replay.getReplay = async () => ({ replay: { liveId, title: "快乐🎉", startedAt: null, member: { id: "", name: "" }, cover: "" } });
  replay.listReplays = async () => ({
    list: [{ liveId, title: "快乐🎉", startedAt: "1792939614108", member: { id: "407126", name: "SNH48-杨晔" } }],
    next: "0",
  });
  media.downloadShared = async ({ onProgress }) => {
    onProgress({ completed: 1, total: 1 });
    return { liveId, filePath, durationSeconds: 7299, size: fs.statSync(filePath).size, sha256, verification: "full", streams: [{ codec_type: "video" }, { codec_type: "audio" }] };
  };
  recorder.listActive = () => [];
  try {
    const queued = imports.enqueue({ liveId, autoUpload: false });
    const result = await waitFor(queued.id);
    assert.equal(result.status, "done", result.error || "");
    const recording = manager.getRecording(result.recordingId);
    assert.equal(recording.memberName, "SNH48-杨晔", "member comes from the replay list");
    assert.equal(recording.memberId, "407126");
    assert.equal(recording.startedAt, new Date(1792939614108).toISOString(), "start time is the real live time");
    assert.match(recording.title, /^2026-10-25-/, "title carries the live date, not the import date");
    assert.doesNotMatch(recording.title, /Pocket48/);
  } finally {
    replay.getReplay = oldGet; replay.listReplays = oldList; media.downloadShared = oldDownload; recorder.listActive = oldActive;
  }
});

test("manual replay import rejects a second valid archive for the same live ID", () => {
  const recording = manager.addRecording({ source: "pocket48", liveId: "990002", status: "done", filePath: path.join(process.env.RECORDINGS_DIR, "existing.mp4") });
  fs.writeFileSync(recording.filePath, "existing");
  assert.throws(() => imports.enqueue({ liveId: "990002" }), error => error.code === "ARCHIVE_EXISTS" && error.statusCode === 409);
});

test("done is published only after a failed auto upload enqueue is recorded", async () => {
  const oldGet = replay.getReplay;
  const oldFind = replay.findReplayMetadata;
  const oldDownload = media.downloadShared;
  const oldActive = recorder.listActive;
  const oldEnqueue = uploadQueue.enqueueRecording;
  const liveId = "990003";
  const filePath = path.join(process.env.RECORDINGS_DIR, ".official-replays", liveId, "verified.mp4");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "verified-official-replay-2");
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  replay.getReplay = async () => ({ replay: { liveId, title: "官方回放", startedAt: "2026-09-30T02:00:00.000Z", member: { id: "100", name: "测试成员" } }, streamUrl: "https://example.test/replay.m3u8" });
  replay.findReplayMetadata = async () => ({ liveId, durationSeconds: 12, title: "官方回放", startedAt: "2026-09-30T02:00:00.000Z", member: { id: "100", name: "测试成员" } });
  media.downloadShared = async () => ({ liveId, filePath, durationSeconds: 12, size: fs.statSync(filePath).size, sha256, verification: "full", streams: [{ codec_type: "video", width: 1920, height: 1080 }] });
  recorder.listActive = () => [];
  uploadQueue.enqueueRecording = () => { throw new Error("B站队列暂不可用"); };
  try {
    const queued = imports.enqueue({ liveId, autoUpload: true });
    const result = await waitFor(queued.id);
    assert.equal(result.status, "done");
    assert.equal(result.progress, 100);
    assert.equal(result.uploadQueued, false);
    assert.match(result.error, /归档，但加入 B站草稿队列失败/);
    assert.ok(result.recordingId);
  } finally {
    replay.getReplay = oldGet; replay.findReplayMetadata = oldFind; media.downloadShared = oldDownload; recorder.listActive = oldActive; uploadQueue.enqueueRecording = oldEnqueue;
  }
});
