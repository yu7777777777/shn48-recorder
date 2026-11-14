"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-recovery-"));
process.env.DATA_DIR = path.join(root, "data"); process.env.RECORDINGS_DIR = path.join(root, "recordings");
process.env.COVERS_DIR = path.join(root, "covers"); fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require("../modules/recorder/manager");
const media = require("../modules/recorder/replay-download");
const recovery = require("../modules/recorder/replay-recovery");
const archive = require("../modules/recorder/archive-processor");
const queue = require("../modules/bilibili/queue");
const store = require("../lib/store");
const originalDownload = media.download;
const source = path.join(process.env.RECORDINGS_DIR, "source.mp4");
const creation = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
assert.equal(creation.status, 0, creation.stderr?.toString());
let number = 200;
function add(values = {}) {
  const file = path.join(process.env.RECORDINGS_DIR, `local-${++number}.mp4`); fs.copyFileSync(source, file);
  return manager.addRecording({ source: "pocket48", liveId: String(number), status: "done", filePath: file, fileName: path.basename(file), memberName: "测试成员", title: "测试回放", ...values });
}
function downloaded(rec, values = {}) {
  const directory = recovery._internals.directory(rec.liveId);
  const filePath = path.join(directory, "verified.mp4"); fs.copyFileSync(source, filePath);
  return { liveId: rec.liveId, filePath, durationSeconds: 10, size: fs.statSync(filePath).size, streams: [{ codec_type: "video", width: 160, height: 120 }, { codec_type: "audio" }], downloadedAt: new Date().toISOString(), ...values };
}
test.after(() => { media.download = originalDownload; archive.stop(); fs.rmSync(root, { recursive: true, force: true }); });
test("download completes before original is inspected or pointer replaced; backup persists across restart", async () => {
  const rec = add(); const old = rec.filePath; const hash = await media.digest(old);
  let finish; media.download = async () => { await new Promise(resolve => { finish = resolve; }); return downloaded(rec); };
  const job = recovery.recover(rec, { automatic: false, force: true });
  while (!finish) await new Promise(r => setImmediate(r));
  assert.equal(rec.filePath, old); assert.equal(await media.digest(old), hash);
  assert.throws(() => queue.enqueueRecording(rec.id, { autoUpload: true }), /回放下载/);
  finish(); await job;
  assert.equal(rec.replayRecovery.status, "replaced"); assert.notEqual(rec.filePath, old);
  assert.ok(rec.sourceFiles.includes(old)); assert.equal(await media.digest(old), hash);
  manager.loadState(); const reloaded = manager.getRecording(rec.id);
  assert.equal(reloaded.filePath, rec.filePath); assert.ok(reloaded.sourceFiles.includes(old));
});
test("download failure, short replay, missing audio and lower resolution retain original", async () => {
  const failed = add(); const old = failed.filePath;
  media.download = async () => { throw new Error("官方回放分片失效"); };
  await recovery.recover(failed, { automatic: false, force: true });
  assert.equal(failed.filePath, old); assert.equal(failed.replayRecovery.status, "failed");
  for (const values of [{ durationSeconds: 0.01 }, { streams: [{ codec_type: "video", width: 160, height: 120 }] }, { streams: [{ codec_type: "video", width: 80, height: 60 }, { codec_type: "audio" }] }]) {
    const rec = add(); const before = rec.filePath; media.download = async () => downloaded(rec, values);
    await recovery.recover(rec, { automatic: false, force: true });
    assert.equal(rec.filePath, before); assert.equal(rec.replayRecovery.status, "kept_local");
  }
});
test("existing draft, subtitles or clips block replacement even if added during download", async () => {
  for (const kind of ["draft", "subtitles", "clip"]) {
    const rec = add(); const before = rec.filePath;
    media.download = async () => {
      if (kind === "draft") manager.updateRecording(rec.id, { draftId: 1 });
      if (kind === "subtitles") store.save(`analysis_${rec.id}`, { segments: [{ start: 0, end: 1, text: "字幕" }] });
      if (kind === "clip") manager.addRecording({ source: "clip", parentRecordingId: rec.id, status: "done" });
      return downloaded(rec);
    };
    await recovery.recover(rec, { automatic: false, force: true });
    assert.equal(rec.filePath, before); assert.equal(rec.replayRecovery.status, "kept_local");
    assert.ok(fs.existsSync(rec.replayRecovery.replayFilePath));
  }
});
test("atomic recording persistence failure cannot switch in-memory or persisted file pointer", async () => {
  const rec = add(); const original = rec.filePath;
  const destination = store.filePath("recordings");
  const persisted = JSON.parse(fs.readFileSync(destination));
  // The unique temporary name makes filesystem tricks unreliable, so inject the
  // failure at the single write choke point instead.
  const realAtomicWrite = store.atomicWrite;
  store.atomicWrite = () => { throw new Error("模拟磁盘写入失败"); };
  try { assert.throws(() => manager.updateRecording(rec.id, { filePath: "bad.mp4" }), /磁盘写入失败/); }
  finally { store.atomicWrite = realAtomicWrite; }
  assert.equal(rec.filePath, original);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), persisted);
  assert.equal(JSON.parse(fs.readFileSync(destination)).find(item => item.id === rec.id).filePath, original);
});
test("automatic failure waits and blocks upload; retry exhaustion releases original", async () => {
  const rec = add({ autoUpload: true });
  media.download = async () => { throw new Error("官方回放尚未生成完整清单"); };
  await recovery.recover(rec, { force: true });
  assert.equal(rec.replayRecovery.status, "waiting_replay"); assert.ok(rec.replayRecovery.nextAttemptAt);
  assert.equal(recovery.holdsUpload(rec), true);
  manager.updateRecording(rec.id, { replayRecovery: { ...rec.replayRecovery, attempts: 5 } });
  await recovery.recover(rec, { force: true });
  assert.equal(rec.replayRecovery.status, "failed"); assert.equal(recovery.holdsUpload(rec), false);
});
test("distinct live IDs never merge just because member and title match", () => {
  assert.equal(archive._internals.compatible({ memberName: "a", liveTitle: "b", liveId: "1" }, { memberName: "a", liveTitle: "b", liveId: "2" }), false);
});
test("upload quality gate requires persisted replay review and explicit local confirmation", () => {
  const missing = add({ autoUpload: true });
  assert.equal(recovery.uploadReadiness(missing, { autoUpload: true }).code, "REPLAY_RECOVERY_REQUIRED");
  manager.updateRecording(missing.id, { replayRecovery: { status: "kept_local" } });
  assert.equal(recovery.uploadReadiness(missing, { autoUpload: true }).code, "LOCAL_CONFIRMATION_REQUIRED");
  assert.equal(recovery.uploadReadiness(missing, { confirmLocal: true }).ready, true);
  manager.updateRecording(missing.id, { replayRecovery: { status: "failed" } });
  assert.equal(recovery.uploadReadiness(missing, { autoUpload: true }).code, "REPLAY_RECOVERY_FAILED");
});
test("upload queue item captures archive version and file fingerprint", () => {
  const rec = add({ replayRecovery: { status: "replaced" }, archiveVersion: 3 });
  const item = queue._internals.buildItem(rec, { autoUpload: true });
  assert.equal(item.archiveVersion, 3);
  assert.equal(item.fileFingerprint.size, fs.statSync(rec.filePath).size);
});
test("automatic complete local archive uses metadata and decode validation without replay download", async () => {
  const replay = require("../modules/pocket48/replay");
  const before = replay.findReplayMetadata;
  const rec = add({ autoUpload: true });
  const seconds = Number((await media.probe(rec.filePath)).format.duration);
  replay.findReplayMetadata = async () => ({ durationSeconds: seconds });
  media.download = async () => { throw new Error("unexpected duplicate download"); };
  try {
    await recovery.recover(rec, { automatic: true, force: true });
    assert.equal(rec.replayRecovery.status, "checked_local");
    assert.equal(recovery.uploadReadiness(rec, { autoUpload: true }).ready, true);
    assert.equal(rec.replayRecovery.qualityGate.source, "local_verified");
  } finally { replay.findReplayMetadata = before; }
});
test("manual endpoint returns immediately, locks deletion/upload, and exposes progress", async () => {
  const rec = add(); let finish;
  media.download = async () => { await new Promise(resolve => { finish = resolve; }); return downloaded(rec); };
  const app = express(); app.use(express.json()); app.use("/", require("../routes/recordings"));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/${rec.id}/recover-replay`, { method: "POST" })).status, 202);
    while (!finish) await new Promise(r => setImmediate(r));
    assert.equal((await fetch(`${base}/${rec.id}`, { method: "DELETE" })).status, 409);
    assert.equal((await fetch(`${base}/${rec.id}/upload`, { method: "POST" })).status, 409);
    finish(); while (recovery.busy(rec.id)) await new Promise(r => setTimeout(r, 10));
    assert.equal(rec.replayRecovery.status, "replaced");
    const download = await fetch(`${base}/${rec.id}/download`);
    assert.match(download.headers.get("content-disposition"), /local-/);
    await download.arrayBuffer();
    const original = await fetch(`${base}/${rec.id}/original-download`);
    assert.equal(original.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await original.arrayBuffer()), fs.readFileSync(rec.sourceFiles.at(-1))), 0);
  } finally { finish?.(); await new Promise(r => server.close(r)); }
});
