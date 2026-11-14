"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-archive-test-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
process.env.COVERS_DIR = path.join(root, "covers");
process.env.COOKIES_PATH = path.join(root, "cookies.json");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require("../modules/recorder/manager");
const archive = require("../modules/recorder/archive-processor");
const queue = require("../modules/bilibili/queue");
const pocketRecorder = require("../modules/pocket48/recorder");
const { EventEmitter } = require("events");
const draft = require("../modules/bilibili/draft");
test.after(() => { archive.stop(); fs.rmSync(root, { recursive: true, force: true }); });
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
const available = !spawnSync(ffmpeg, ["-version"]).error && !spawnSync(ffprobe, ["-version"]).error;
function clip(name, dimensions = "160x120", audio = true) {
  const file = path.join(process.env.RECORDINGS_DIR, `${name}.flv`);
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=blue:s=${dimensions}:r=25`,
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []), "-t", "1", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", file]);
  assert.equal(result.status, 0, result.stderr?.toString());
  return file;
}
function recording(name, filePath, extra = {}) {
  return manager.addRecording({ source: "pocket48", memberId: name, memberName: "测试成员", title: name,
    status: "done", filePath, startedAt: "2026-09-03T10:00:00Z", endedAt: "2026-09-03T10:00:01Z", ...extra });
}
test("manual stop immediately archives independently; automatic stop still waits", { skip: !available }, async () => {
  archive.start();
  async function finish(name, manual) {
    const file = clip(name);
    const rec = recording("manual-boundary", file, { status: "recording", startedAt: new Date().toISOString() });
    const child = new EventEmitter();
    child.stdin = { write() { setImmediate(() => child.emit("close", 0, null)); } };
    const entry = { recordingId: rec.id, child, partialPath: file, finalPath: file + ".flv" };
    pocketRecorder._internals.active.set(rec.id, entry);
    child.once("close", (code, signal) => pocketRecorder._internals.finalize(entry, code, signal, null));
    return pocketRecorder.stop(rec.id, manual ? { manual: true } : undefined);
  }
  const automatic = await finish("automatic-stop", false);
  assert.equal(automatic.status, "waiting_merge");
  assert.equal(automatic.manualStop, false);
  const manual = await finish("manual-stop", true);
  assert.equal(manual.status, "processing");
  assert.equal(manual.manualStop, true);
  const deadline = Date.now() + 10000;
  while (manual.status === "processing") {
    assert.ok(Date.now() < deadline, "manual archive should not wait five minutes");
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(manual.status, "done", manual.archiveError);
  assert.equal(manual.segmentCount, 1);
  assert.equal(automatic.status, "waiting_merge");
  assert.ok(fs.existsSync(automatic.filePath));
  archive.stop();
  // Persisted manual marker must survive process restart and continue without waiting.
  const resumed = recording("resumed-manual", clip("resumed-manual"), { status: "processing", manualStop: true, endedAt: new Date().toISOString() });
  manager.loadState();
  const completed = await archive.processRecording(resumed.id, { autoEnqueue: false });
  assert.equal(completed.status, "done");
});
test("archive rejects unfinished recordings and paths outside the recording root", async () => {
  const rec = recording("unfinished", null, { status: "recording" });
  await assert.rejects(archive.prepareForUpload(rec.id), /尚未结束/);
  const outside = path.join(root, "outside.flv");
  fs.writeFileSync(outside, "keep");
  const other = recording("outside", outside);
  await assert.rejects(archive.prepareForUpload(other.id), /outside/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});
test("mixed-size/audio reconnects merge once, validate, and retain originals", { skip: !available }, async () => {
  const a = clip("first");
  const b = clip("second", "120x160", false);
  const first = recording("same-live", a);
  const second = recording("same-live", b, { startedAt: "2026-09-03T10:00:20Z", endedAt: "2026-09-03T10:00:21Z" });
  const job = archive.prepareForUpload(first.id);
  const duplicate = archive.prepareForUpload(first.id);
  const [result, again] = await Promise.all([job, duplicate]);
  assert.equal(result.filePath, again.filePath);
  assert.equal(result.segmentCount, 2);
  assert.equal(manager.getRecording(second.id).status, "merged");
  assert.equal(path.basename(result.filePath), "2026-09-03-测试成员-same-live.mp4");
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  const info = await archive._internals.probe(result.filePath);
  assert.ok(Number(info.format.duration) >= 1.9);
  assert.equal(manager.getQueue().length, 0);
});
test("legacy queued conversion reserves a slot before awaiting and saves one draft", { skip: !available }, async () => {
  fs.writeFileSync(process.env.COOKIES_PATH, "{}");
  const originals = { loadCredentials: draft.loadCredentials, uploadFileToUpos: draft.uploadFileToUpos, saveDraft: draft.saveDraft, uploadCover: draft.uploadCover };
  let uploads = 0;
  draft.loadCredentials = () => ({ cookie: "test", csrf: "test" });
  draft.uploadFileToUpos = async ({ filePath }) => { uploads++; assert.equal(path.extname(filePath), ".mp4"); return { filename: "test", bizId: 1 }; };
  draft.uploadCover = async ({ filePath }) => { assert.ok(fs.statSync(filePath).size > 0); return "https://i0.hdslb.com/bfs/archive/test.jpg"; };
  draft.saveDraft = async ({ meta }) => { assert.equal(meta.cover, "https://i0.hdslb.com/bfs/archive/test.jpg"); return { draftId: "test-draft" }; };
  try {
    // Legacy queue items pre-date the replay quality gate; manualStop records the
    // operator's explicit confirmation so the upload path itself is what is tested here.
    const rec = recording("queue-test", clip("queued"), { manualStop: true });
    const item = manager.enqueueUpload({ recordingId: rec.id, file: rec.filePath, title: rec.title, mode: "draft" });
    const work = queue.processItem(item.id);
    assert.ok(queue._internals.running.has(item.id));
    queue._internals.pump();
    await work;
    assert.equal(uploads, 1);
    assert.equal(manager.getQueueItem(item.id).status, "done");
    assert.equal(manager.getRecording(rec.id).draftId, "test-draft");
    assert.equal(queue._internals.running.size, 0);
  } finally { Object.assign(draft, originals); }
});
