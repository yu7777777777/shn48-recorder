"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-queue-resume-"));
process.env.DATA_DIR = dataDir;
process.env.COOKIES_PATH = path.join(dataDir, "cookies.json");
process.env.COVERS_DIR = path.join(dataDir, "covers");
const manager = require("../modules/recorder/manager");
const queue = require("../modules/bilibili/queue");
const routes = require("../routes/bilibili");
const { accountService } = require("../modules/bilibili/account");
const store = require("../lib/store");
const sse = require("../lib/sse");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Count upload_queue persistence and SSE traffic without changing behavior.
function trackQueueWrites() {
  const counts = { saves: 0, broadcasts: 0 };
  const rawSave = store.save;
  const rawBroadcast = sse.broadcast;
  store.save = (name, data) => { if (name === "upload_queue") counts.saves += 1; return rawSave(name, data); };
  sse.broadcast = (event, data) => { if (event === "upload-updated") counts.broadcasts += 1; return rawBroadcast(event, data); };
  return { counts, restore() { store.save = rawSave; sse.broadcast = rawBroadcast; } };
}

test("repeated credential resume never touches uploading or paused items", () => {
  const uploading = manager.enqueueUpload({ recordingId: "rec-live", status: "uploading", progress: 42 });
  const paused = manager.enqueueUpload({ recordingId: "rec-paused", status: "paused_recording", pauseReason: "recording_active" });
  const waiting = manager.enqueueUpload({ recordingId: "rec-wait", status: "waiting_credentials", error: "Bilibili is not logged in", autoUpload: true });
  const { counts, restore } = trackQueueWrites();
  try {
    queue.resumeWaitingForCredentials();
    queue.resumeWaitingForCredentials();
    const live = manager.getQueueItem(uploading.id);
    assert.equal(live.status, "uploading");
    assert.equal(live.progress, 42);
    assert.notEqual(live.error, "Server restarted during upload");
    assert.equal(manager.getQueueItem(paused.id).status, "paused_recording");
    const woken = manager.getQueueItem(waiting.id);
    assert.equal(woken.status, "queued");
    assert.equal(woken.error, null);
    assert.equal(counts.saves, 1);
    assert.equal(counts.broadcasts, 1);
  } finally {
    restore();
    for (const id of [uploading.id, paused.id, waiting.id]) manager.dequeueUpload(id);
  }
});

test("startup recovery revives a persisted uploading item and schedules it", async () => {
  const item = manager.enqueueUpload({ recordingId: "rec-restart", status: "uploading", progress: 77, autoUpload: true });
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "upload_queue.json"), "utf8"));
  assert.equal(persisted.find((entry) => entry.id === item.id).status, "uploading");
  assert.equal(queue.isUploadInFlight(item.id), false);
  const { counts, restore } = trackQueueWrites();
  try {
    queue.resumeQueued();
    const revived = manager.getQueueItem(item.id);
    assert.equal(revived.status, "queued");
    assert.equal(revived.error, "Server restarted during upload");
    assert.equal(counts.saves, 1);
  } finally { restore(); }
  // The scheduled pump picks the revived item up; with no credentials it parks
  // on waiting_credentials instead of staying queued forever.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getQueueItem(item.id).status, "waiting_credentials");
  manager.dequeueUpload(item.id);
});

test("updateQueueItem skips persistence and broadcast when values are unchanged", () => {
  const item = manager.enqueueUpload({ recordingId: "rec-noop", title: "same" });
  const { counts, restore } = trackQueueWrites();
  try {
    const same = manager.updateQueueItem(item.id, { status: "queued", title: "same", retries: 0 });
    assert.equal(same.status, "queued");
    assert.equal(counts.saves, 0);
    assert.equal(counts.broadcasts, 0);
    manager.updateQueueItem(item.id, { progress: 50 });
    assert.equal(counts.saves, 1);
    manager.updateQueueItem(item.id, { progress: 50 });
    assert.equal(counts.saves, 1);
    const changed = manager.updateQueueItem(item.id, { status: "failed", error: "boom" });
    assert.equal(changed.status, "failed");
    assert.equal(counts.saves, 2);
    assert.equal(counts.broadcasts, 2);
  } finally {
    restore();
    manager.dequeueUpload(item.id);
  }
});

test("account status polling leaves live uploads untouched", async () => {
  const item = manager.enqueueUpload({ recordingId: "rec-poll", status: "uploading", progress: 66 });
  const originalGetStatus = accountService.getStatus;
  accountService.getStatus = async () => ({ authenticated: true });
  const { counts, restore } = trackQueueWrites();
  try {
    await routes._internals.accountStatus({}, { json() {} });
    const live = manager.getQueueItem(item.id);
    assert.equal(live.status, "uploading");
    assert.equal(live.progress, 66);
    assert.notEqual(live.error, "Server restarted during upload");
    assert.equal(counts.saves, 0);
    assert.equal(counts.broadcasts, 0);
  } finally {
    restore();
    accountService.getStatus = originalGetStatus;
    manager.dequeueUpload(item.id);
  }
});
