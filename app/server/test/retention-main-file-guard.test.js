"use strict";

// Regression tests for the 2026-10-26 data loss: reclaiming "replay cache" deleted
// five finished archives. For an official_replay archive the verified main file
// lives at `.official-replays/<liveId>/verified.mp4`, and its path is ALSO stored
// as `replayRecovery.replayFilePath` — which sweep() treated as a reclaimable
// cache. Nothing that is a record's main file may ever be deleted by retention.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-retention-guard-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const retention = require("../modules/recorder/retention");

const GiB = 1024 ** 3;
const DAY = 86400000;
const recordingsRoot = fs.realpathSync(process.env.RECORDINGS_DIR);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeArchive(liveId, { bytes = 4096 } = {}) {
  const dir = path.join(recordingsRoot, ".official-replays", liveId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "complete.json"), "{}");
  const filePath = path.join(dir, "verified.mp4");
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
  return filePath;
}

test("sweep never deletes the verified main file of an official_replay archive", async () => {
  const liveId = "1320546015452663801";
  const filePath = writeArchive(liveId, { bytes: 8192 });
  // Exactly the shape of the five records that were lost: the main file is also
  // recorded as the replay path, and the archive is past its retention window.
  const rec = manager.addRecording({
    source: "pocket48",
    liveId,
    status: "done",
    filePath,
    fileName: "verified.mp4",
    size: 8192,
    fileSize: 8192,
    archiveOrigin: "official_replay",
    replayRecovery: { status: "replaced", replayFilePath: filePath },
    // Force the "already verified, window elapsed" branch.
    retentionVerifiedAt: new Date(Date.now() - 5 * DAY).toISOString(),
    retentionFingerprint: (() => {
      const st = fs.statSync(filePath);
      return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
    })(),
  });

  await retention.sweep();

  assert.equal(fs.existsSync(filePath), true, "the verified archive must survive sweep");
  const after = manager.getRecording(rec.id);
  assert.equal(after.status, "done", "the record must not be marked deleted");
});

test("sweep still reclaims genuine source fragments of an archived recording", async () => {
  const liveId = "1320546015452663802";
  const filePath = writeArchive(liveId, { bytes: 8192 });
  const fragment = path.join(recordingsRoot, `frag-${liveId}.flv`);
  fs.writeFileSync(fragment, Buffer.alloc(2048));
  const rec = manager.addRecording({
    source: "pocket48",
    liveId,
    status: "done",
    filePath,
    sourceFiles: [fragment],
    size: 8192,
    fileSize: 8192,
    archiveOrigin: "official_replay",
    retentionVerifiedAt: new Date(Date.now() - 5 * DAY).toISOString(),
    retentionFingerprint: (() => {
      const st = fs.statSync(filePath);
      return { path: filePath, size: st.size, mtimeMs: st.mtimeMs };
    })(),
  });

  await retention.sweep();

  assert.equal(fs.existsSync(filePath), true, "main file still protected");
  assert.equal(fs.existsSync(fragment), false, "reclaimable fragment is still reclaimed");
  assert.equal(manager.getRecording(rec.id).status, "done");
});

test("water-level purge never deletes an archive main file either", async () => {
  // The 2026-10-26 loss came from purge(), not sweep(): the inventory classifies
  // `.official-replays/<liveId>/verified.mp4` as residual/untracked once a record is
  // no longer "done", and purge() unlinked it. Every delete path needs the guard.
  const liveId = "1320546015452663804";
  const filePath = writeArchive(liveId, { bytes: 8192 });
  const rec = manager.addRecording({
    source: "pocket48", liveId, status: "done", filePath,
    size: 8192, fileSize: 8192, archiveOrigin: "official_replay",
  });
  const original = {
    getRecordings: manager.getRecordings,
    getQueue: manager.getQueue,
    inventory: require("../modules/recorder/storage").inventory,
    verifyFull: require("../modules/recorder/replay-download").verifyFull,
    freeBytes: retention._internals.freeBytes,
  };
  const storage = require("../modules/recorder/storage");
  const media = require("../modules/recorder/replay-download");
  // Below the reserve line so purge() runs, and an inventory that misreports the
  // main file as reclaimable cache — exactly the shape of the production bug.
  storage.inventory = () => ({
    files: [{ filePath, size: 8192, kind: "untracked", locked: false }],
    fileCount: 1, totalBytes: 8192, extraBytes: 8192,
  });
  manager.getQueue = () => [];
  media.verifyFull = async () => true;
  try {
    const result = await retention.purge(recordingsRoot, { force: true });
    assert.equal(fs.existsSync(filePath), true, "purge must not delete a main archive");
    assert.notEqual(result?.files, 1, "the main file must not be counted as reclaimed");
    assert.equal(manager.getRecording(rec.id)?.status, "done");
  } finally {
    storage.inventory = original.inventory;
    manager.getQueue = original.getQueue;
    media.verifyFull = original.verifyFull;
  }
});

test("reclaimNow refuses any path that is a record main file", async () => {
  const liveId = "1320546015452663803";
  const filePath = writeArchive(liveId, { bytes: 4096 });
  const cache = path.join(recordingsRoot, ".official-replays", liveId, "asset-00001.ts");
  fs.writeFileSync(cache, Buffer.alloc(1024));
  manager.addRecording({
    source: "pocket48", liveId, status: "done", filePath, archiveOrigin: "official_replay",
  });

  const result = await retention.reclaimNow(recordingsRoot, {
    targetBytes: 1 * GiB,
    statfs: () => ({ bavail: 0, bsize: 1 }),
    // Misclassify the main file as untracked cache on purpose: ownership must win.
    inventory: () => [
      { filePath, size: 4096, kind: "untracked", locked: false },
      { filePath: cache, size: 1024, kind: "untracked", locked: false },
    ],
  });

  assert.equal(fs.existsSync(filePath), true, "main file survives even when misclassified");
  assert.equal(fs.existsSync(cache), false, "true cache is reclaimed");
  assert.ok(result.files >= 1);
});
