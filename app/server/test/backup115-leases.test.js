"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup115-leases-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
process.env.COVERS_DIR = path.join(root, "covers");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const leases = require("../modules/backup115/leases");
const manager = require("../modules/recorder/manager");
const storage = require("../modules/recorder/storage");
const retention = require("../modules/recorder/retention");
const media = require("../modules/recorder/replay-download");
const recovery = require("../modules/recorder/replay-recovery");
const routes = require("../routes/recordings");
let seq = 0;
function file(ext = "mp4") { const p = path.join(process.env.RECORDINGS_DIR, "file-" + (++seq) + "." + ext); fs.writeFileSync(p, "video"); return p; }
function record(values = {}) { return manager.addRecording({ status: "done", filePath: file(), ...values }); }
function remove(route, params) {
  const layer = routes.stack.find(item => item.route?.path === route && item.route.methods.delete);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  // Async handlers (DELETE /storage/:fileId awaits the inventory) resolve before res is returned; sync handlers keep the old behavior.
  const result = layer.route.stack[0].handle({ params }, res);
  return result && typeof result.then === "function" ? result.then(() => res) : res;
}
test.afterEach(() => leases._reset());
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("leases normalize paths, count independent acquisitions, and release idempotently", () => {
  const p = file();
  const a = leases.acquire("a", [p, path.join(path.dirname(p), ".", path.basename(p))]);
  const b = leases.acquire("a", [p]);
  const c = leases.acquire("b", [p]);
  a(); a(); assert.equal(leases.lockedPath(p), true);
  leases.releaseOwner("a"); b(); assert.equal(leases.lockedPath(p), true);
  c(); assert.equal(leases.lockedPath(p), false);
  const stale = leases.acquire("b", [p]); leases.releaseOwner("b");
  const fresh = leases.acquire("b", [p]); stale(); assert.equal(leases.lockedPath(p), true); fresh();
  assert.equal(leases.lockedPath(null), false);
});

test("realpath aliases share a lease; nonexistent attachments use resolved paths", () => {
  const alias = path.join(root, "alias");
  fs.symlinkSync(process.env.RECORDINGS_DIR, alias, process.platform === "win32" ? "junction" : "dir");
  const p = file(); leases.acquire("alias", [path.join(alias, path.basename(p))]);
  assert.equal(leases.lockedPath(p), true);
  const missing = path.join(root, "subtitle.srt"); leases.acquire("attachment", [missing]);
  assert.equal(leases.lockedPath(path.resolve(missing)), true);
});

test("recording locks cover main, shared sources and replay, but not stale status summaries", () => {
  const p = file(); leases.acquire("other-recording-job", [p]);
  for (const rec of [{ filePath: p }, { sourceFiles: [p] }, { replayRecovery: { replayFilePath: p } }]) assert.equal(leases.lockedRecording(rec), true);
  assert.equal(leases.lockedRecording({ backup115: { status: "uploading" }, filePath: file() }), false);
  assert.equal(leases.lockedRecording(null), false);
});

test("DELETE refuses a queued shared physical lease and allows deletion after cancellation", () => {
  const p = file(), raw = file("flv");
  const rec = record({ filePath: p, sourceFiles: [raw], backup115: { status: "uploading" } });
  leases.acquire("queued-for-other-id", [raw]);
  let res = remove("/:id", { id: rec.id });
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /先取消115备份/);
  assert.equal(rec.status, "done"); assert.ok(fs.existsSync(p)); assert.ok(fs.existsSync(raw));
  leases.releaseOwner("queued-for-other-id");
  res = remove("/:id", { id: rec.id }); assert.equal(res.statusCode, 200);
  assert.equal(fs.existsSync(p), false); assert.equal(fs.existsSync(raw), false);
});

test("storage inventory and cleanup protect leased untracked files", async () => {
  const p = file("flv"); leases.acquire("queued", [p]);
  const item = (await storage.inventory(process.env.RECORDINGS_DIR)).files.find(f => f.filePath === p);
  assert.equal(item.locked, true);
  const res = await remove("/storage/:fileId", { fileId: item.id });
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /先取消115备份/); assert.ok(fs.existsSync(p));
  leases.releaseOwner("queued");
  assert.equal((await remove("/storage/:fileId", { fileId: item.id })).statusCode, 200);
});

test("final unlink rechecks a lease acquired after inventory", () => {
  const p = file("flv"), original = fs.realpathSync;
  let calls = 0;
  fs.realpathSync = function(value, ...args) {
    const result = original.call(this, value, ...args);
    if (value === p && ++calls === 1) leases.acquire("late", [p]);
    return result;
  };
  try { assert.throws(() => routes._internals.deleteRecordingFile({ filePath: p }), error => error.statusCode === 409); }
  finally { fs.realpathSync = original; }
  assert.ok(fs.existsSync(p));
});

test("retention rechecks locks acquired during awaited verification", async () => {
  const raw = file("flv"), rec = record({ sourceFiles: [raw] });
  const original = media.verifyFull;
  media.verifyFull = async p => { if (p === rec.filePath) leases.acquire("during-verify", [raw]); };
  try {
    await retention.sweep(Date.now() + 2 * 86400000);
    assert.ok(fs.existsSync(raw)); assert.equal(rec.retentionVerifiedAt, undefined);
  } finally { media.verifyFull = original; }
});

test("water-level purge rechecks a lease acquired after candidate inventory", async () => {
  const p = file("flv"), stat = fs.statSync, statfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0n, bsize: 1n });
  let calls = 0;
  // With the async inventory (fs.promises.stat) no longer passing through this
  // mock, the first statSync(p) is the purge's per-candidate recheck — acquiring
  // the lease there still exercises "lease appeared after the inventory snapshot,
  // before the deletion recheck".
  fs.statSync = function(value, ...args) {
    const result = stat.call(this, value, ...args);
    if (value === p && ++calls === 1) leases.acquire("late-purge", [p]);
    return result;
  };
  const verify = media.verifyFull; media.verifyFull = async () => {};
  try { await retention.purge(process.env.RECORDINGS_DIR); assert.ok(fs.existsSync(p)); }
  finally { fs.statSync = stat; fs.statfsSync = statfs; media.verifyFull = verify; }
});

test("expired retention candidates and transient replay cache keep their physical leases", async () => {
  const now = Date.now(), raw = file("flv"), rec = record({ sourceFiles: [raw] });
  const stat = fs.statSync(rec.filePath);
  manager.updateRecording(rec.id, { retentionVerifiedAt: new Date(now - 2 * 86400000).toISOString(), retentionFingerprint: { path: rec.filePath, size: stat.size, mtimeMs: stat.mtimeMs } });
  const dir = path.join(process.env.RECORDINGS_DIR, ".official-replays", "88888"); fs.mkdirSync(dir, { recursive: true });
  const transient = path.join(dir, "asset-00001.ts"); fs.writeFileSync(transient, "cache"); fs.utimesSync(transient, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
  leases.acquire("other-id-source", [raw]); leases.acquire("other-id-cache", [transient]);
  const original = media.verifyFull; media.verifyFull = async () => {};
  try { await retention.sweep(now); assert.ok(fs.existsSync(raw)); assert.ok(fs.existsSync(transient)); assert.ok(fs.existsSync(rec.filePath)); }
  finally { media.verifyFull = original; }
});

test("replay replacement rechecks target lease immediately before switching the pointer", async () => {
  const rec = record({ source: "pocket48", liveId: "77777" }), before = rec.filePath;
  const official = { filePath: file(), durationSeconds: 10, size: 5, streams: [{ codec_type: "video", width: 160, height: 120 }] };
  const download = media.downloadShared, probe = media.probe, atomic = media.atomicJson;
  media.downloadShared = async () => official;
  media.probe = async () => ({ format: { duration: 1 }, streams: official.streams });
  media.atomicJson = (...args) => { atomic(...args); leases.acquire("late-target", [official.filePath]); };
  try {
    await recovery.recover(rec, { automatic: false, force: true });
    assert.equal(rec.filePath, before); assert.equal(rec.replayRecovery.status, "kept_local"); assert.match(rec.replayRecovery.message, /先取消115备份/);
  } finally { media.downloadShared = download; media.probe = probe; media.atomicJson = atomic; }
});

test("replay replacement rechecks a shared-path lease acquired during probe", async () => {
  const rec = record({ source: "pocket48", liveId: "99999" }), before = rec.filePath;
  const official = { filePath: file(), durationSeconds: 10, size: 5, streams: [{ codec_type: "video", width: 160, height: 120 }] };
  const download = media.downloadShared, probe = media.probe;
  media.downloadShared = async () => official;
  media.probe = async () => { leases.acquire("another-id", [before]); return { format: { duration: 1 }, streams: official.streams }; };
  try {
    await recovery.recover(rec, { automatic: false, force: true });
    assert.equal(rec.filePath, before); assert.equal(rec.replayRecovery.status, "kept_local");
    assert.match(rec.replayRecovery.message, /先取消115备份/); assert.ok(fs.existsSync(before));
  } finally { media.downloadShared = download; media.probe = probe; }
});
