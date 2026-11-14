"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require("../modules/recorder/manager");
const media = require("../modules/recorder/replay-download");
const retention = require("../modules/recorder/retention");
const originalVerify = media.verifyFull;
media.verifyFull = async file => { if (file.includes("invalid")) throw new Error("invalid media"); };
const day = 86400000;
const now = Date.now();
function file(name) { const p = path.join(process.env.RECORDINGS_DIR, name); fs.writeFileSync(p, "video"); return p; }
function add(name, values = {}) { return manager.addRecording({ status: "done", filePath: file(`${name}.mp4`), sourceFiles: [file(`${name}.flv`)], ...values }); }
test.after(() => { media.verifyFull = originalVerify; fs.rmSync(root, { recursive: true, force: true }); });
test("existing archives start a verified 24-hour window; expiry removes only duplicate and its references", async () => {
  const r = add("first"); const raw = r.sourceFiles[0];
  const merged = manager.addRecording({ status: "merged", filePath: raw, mergedInto: r.id });
  await retention.sweep(now);
  assert.ok(fs.existsSync(raw)); assert.equal(Date.parse(r.retentionVerifiedAt), now);
  await retention.sweep(now + day - 1); assert.ok(fs.existsSync(raw));
  await retention.sweep(now + day + 1);
  assert.ok(fs.existsSync(r.filePath)); assert.ok(!fs.existsSync(raw)); assert.deepEqual(r.sourceFiles, []);
  assert.equal(merged.status, "merged");
});
test("other main files, active uploads, invalid media, and files outside root remain", async () => {
  const shared = add("shared", { retentionVerifiedAt: new Date(now - day - 1).toISOString() });
  const raw = shared.sourceFiles[0];manager.addRecording({ status: "done", filePath: raw });
  const uploading = add("uploading", { retentionVerifiedAt: new Date(now - day - 1).toISOString() });
  manager.enqueueUpload({ recordingId: uploading.id, file: uploading.sourceFiles[0], status: "queued" });
  const invalid = add("invalid");
  const outside = path.join(root, "outside.flv"); fs.writeFileSync(outside, "video");
  add("outside", { sourceFiles: [outside], retentionVerifiedAt: new Date(now - day - 1).toISOString() });
  await retention.sweep(now);
  assert.ok(fs.existsSync(raw)); assert.ok(fs.existsSync(uploading.sourceFiles[0]));assert.ok(fs.existsSync(invalid.sourceFiles[0]));assert.ok(fs.existsSync(outside));
  assert.equal(invalid.retentionVerifiedAt, undefined);
});
test("expired inactive replay fragments clear while recent resume data stays", async () => {
  const old = path.join(process.env.RECORDINGS_DIR, ".official-replays", "123");fs.mkdirSync(old, { recursive: true });
  const oldFile = path.join(old, "asset-00001.ts");fs.writeFileSync(oldFile, "fragment");fs.utimesSync(oldFile, new Date(now - day - 10), new Date(now - day - 10));
  const fresh = path.join(process.env.RECORDINGS_DIR, ".official-replays", "124");fs.mkdirSync(fresh, { recursive: true });fs.writeFileSync(path.join(fresh, "asset-00001.ts"), "fragment");
  await retention.sweep(now);
  assert.ok(!fs.existsSync(oldFile)); assert.ok(fs.existsSync(path.join(fresh, "asset-00001.ts")));
});
