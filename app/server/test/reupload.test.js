"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-reupload-"));
process.env.DATA_DIR = dataDir;
const manager = require("../modules/recorder/manager");
const queue = require("../modules/bilibili/queue");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("manual reupload retry bypasses historical completed guard only for the current job", () => {
  const file = path.join(dataDir, "repaired.mp4");
  fs.writeFileSync(file, "video");
  const rec = manager.addRecording({ id: "reupload-rec", status: "done", filePath: file, title: "repaired", archiveVersion: 2, replayAudit: { status: "repaired_local_published" }, uploadStatus: "failed" });
  manager.enqueueUpload({ recordingId: rec.id, file, title: rec.title, mode: "draft", status: "done", draftId: "123" });
  const item = manager.enqueueUpload({ recordingId: rec.id, file, title: rec.title, mode: "draft", manualReupload: true, status: "failed" });
  manager.updateRecording(rec.id, { uploadJobId: item.id });
  const queued = queue.retry(item.id);
  assert.equal(queued.status, "queued");
  manager.updateRecording(rec.id, { uploadJobId: "newer-job" });
  assert.throws(() => queue.retry(item.id), error => error.code === "REUPLOAD_STALE");
});
