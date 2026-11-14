"use strict";
// Water-level purge: the operator keeps every archive main file and deletes them
// by hand, so the automatic pass may only reclaim fragments, cache and strays.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-quota-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require("../modules/recorder/manager");
const media = require("../modules/recorder/replay-download");
const retention = require("../modules/recorder/retention");
const originalVerify = media.verifyFull;
// The suite controls the verification verdict; a real decode would need real media.
let verifyImpl = async () => {};
media.verifyFull = async (file) => verifyImpl(file);
test.after(() => { media.verifyFull = originalVerify; fs.rmSync(root, { recursive: true, force: true }); delete process.env.STORAGE_RESERVE_GIB; delete process.env.STORAGE_TARGET_GIB; });

function file(name, size = 100) {
  const p = path.join(process.env.RECORDINGS_DIR, name);
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  return p;
}
function archive(name, values = {}) {
  return manager.addRecording({
    status: "done",
    filePath: file(`${name}.mp4`, 1000),
    sourceFiles: [file(`${name}.flv`, 400)],
    retentionVerifiedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    ...values,
  });
}

// The purge reads free space from the filesystem, so the threshold is driven from
// the environment and the assertions are about WHICH files survive, not the count.
function setWater(reserveGiB, targetGiB) {
  process.env.STORAGE_RESERVE_GIB = String(reserveGiB);
  process.env.STORAGE_TARGET_GIB = String(targetGiB);
}
// Force the "below reserve" branch regardless of the host's real free space.
function belowReserve() { setWater(1e9, 1e9 + 1); }
function aboveReserve() { setWater(0, 0); }

test("archive main files are never removed by the purge", async () => {
  const rec = archive("keep-main");
  belowReserve();
  await retention.purge(process.env.RECORDINGS_DIR);
  assert.ok(fs.existsSync(rec.filePath), "the archive main file must survive");
  assert.ok(!fs.existsSync(rec.sourceFiles[0]), "its fragment is reclaimable");
});

test("a fragment referenced by an active upload is kept", async () => {
  const rec = archive("uploading");
  const fragment = rec.sourceFiles[0];
  manager.enqueueUpload({ recordingId: rec.id, file: fragment, status: "uploading" });
  belowReserve();
  await retention.purge(process.env.RECORDINGS_DIR);
  assert.ok(fs.existsSync(fragment), "a file an upload is reading must survive");
  const queued = manager.getQueue().find((q) => q.recordingId === rec.id && q.status === "uploading");
  manager.updateQueueItem(queued.id, { status: "failed", error: "test teardown" });
});

test("fragments of an archive that failed verification are kept", async () => {
  verifyImpl = async (f) => { if (f.includes("broken")) throw new Error("decode failed"); };
  const rec = archive("broken", { retentionVerifiedAt: undefined });
  belowReserve();
  await retention.purge(process.env.RECORDINGS_DIR);
  assert.ok(fs.existsSync(rec.sourceFiles[0]), "the last complete copy of a broken archive must survive");
  verifyImpl = async () => {};
});

test("reclaimed fragments drop their references from every owner", async () => {
  const rec = archive("refs");
  const fragment = rec.sourceFiles[0];
  const segment = manager.addRecording({ status: "merged", filePath: fragment, mergedInto: rec.id, sourceFiles: [fragment] });
  belowReserve();
  await retention.purge(process.env.RECORDINGS_DIR);
  assert.ok(!fs.existsSync(fragment));
  assert.deepEqual(manager.getRecording(rec.id).sourceFiles, []);
  assert.deepEqual(manager.getRecording(segment.id).sourceFiles, []);
});

test("stray and residual files are reclaimable, live archive main files are not", async () => {
  const stray = file("stray.mp4", 500);
  const live = archive("live-archive");
  // A "deleted" archive no longer owns a main file: inventory classifies its
  // leftover as a residual, and the operator's intent was to discard that archive.
  const residual = archive("residual");
  manager.updateRecording(residual.id, { status: "deleted" });
  belowReserve();
  await retention.purge(process.env.RECORDINGS_DIR);
  assert.ok(!fs.existsSync(stray), "an unassociated media file is reclaimable");
  assert.ok(!fs.existsSync(residual.filePath), "a deleted archive's leftover is reclaimable");
  assert.ok(fs.existsSync(live.filePath), "a live archive's main file is never the purge's business");
});

test("nothing is reclaimed while free space is above the reserve line", async () => {
  const rec = archive("no-pressure");
  const fragment = rec.sourceFiles[0];
  aboveReserve();
  const result = await retention.purge(process.env.RECORDINGS_DIR);
  assert.equal(result.files, 0);
  assert.ok(fs.existsSync(fragment), "an unpressured disk must not trigger cleanup");
});

test("the config target never sits below the reserve line", () => {
  process.env.STORAGE_RESERVE_GIB = "8";
  process.env.STORAGE_TARGET_GIB = "2";
  const limits = retention._internals.config();
  assert.ok(limits.targetBytes >= limits.reserveBytes, "a target below the reserve would never stop reclaiming");
  assert.equal(limits.reserveBytes, 8 * 1024 ** 3);
});
