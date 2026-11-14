"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { createService } = require("../modules/backup115/service");
const store = require("../lib/store");
const leases = require("../modules/backup115/leases");
function setup() {
 const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup115-scan-")), root = path.join(base, "recordings"), dir = path.join(base, "state"); fs.mkdirSync(root);
 const sources = { rec1: path.join(root, "one.mp4"), rec2: path.join(root, "two.mp4") };
 fs.writeFileSync(sources.rec1, "first source"); fs.writeFileSync(sources.rec2, "second source");
 // rec1 archives later than rec2: after a scan advances autoSince to the newest archivedAt,
 // rec1 stays in the scan window (equality) while rec2 converges out of it.
 const start = Date.now() + 60000;
 const rec1 = { id: "rec1", status: "done", filePath: sources.rec1, title: "直播一", memberName: "成员A", recordedAt: new Date(start + 1000).toISOString(), archivedAt: new Date(start + 1000).toISOString() };
 const rec2 = { id: "rec2", status: "done", filePath: sources.rec2, title: "直播二", memberName: "成员B", recordedAt: new Date(start).toISOString(), archivedAt: new Date(start).toISOString() };
 const records = [rec1, rec2];
 const provider = { invoke: async (command, input = {}, opts = {}) => {
  if (command === "check") return { runtimeAvailable: true, authorized: true, accountId: "100", accountLabel: "测试账号" };
  if (command === "upload") { opts.onProgress?.({ phase: "verifying" }); return { verified: true, accountId: "100", remote: { fileId: "12345678901234567890", parentId: "55", size: input.size, sha1: input.sha1, path: input.remoteDir + "/" + input.filename } }; }
  return {};
 }};
 const manager = { getRecording: id => records.find(r => r.id === id), getRecordings: () => records };
 const service = createService({ root, dir, manager, provider, leases, stable: () => {} });
 service._internals.setConnection({ runtimeAvailable: true, authorized: true, accountId: "100" });
 // snapshot() is the expensive path (analysis JSON load + SRT build + SHA1); it is the only
 // scan-path caller of store.load, so counting analysis_ loads counts snapshots per recording.
 function countSnapshots() {
  const counts = {}, original = store.load;
  store.load = (name, ...args) => { if (String(name).startsWith("analysis_")) counts[name] = (counts[name] || 0) + 1; return original.call(store, name, ...args); };
  return { counts, restore: () => { store.load = original; } };
 }
 function savedAutoSince() { return JSON.parse(fs.readFileSync(service._internals.settingsFile, "utf8")).autoSince; }
 return { service, base, root, dir, sources, records, settingsPath: service._internals.settingsFile, countSnapshots, savedAutoSince,
  cleanup: async () => { await service.stop(); for (const j of service._internals.getJobs()) leases.releaseOwner(j.id); fs.rmSync(base, { recursive: true, force: true }); } };
}
test("scan enqueues new archives once, then converges without repeated snapshots", async () => {
 const x = setup(); try {
  await x.service.start();
  x.service.saveSettings({ autoBackup: true });
  x.service.scan(); await x.service.pump();
  const jobs = x.service.status().jobs;
  assert.equal(jobs.length, 2); assert.ok(jobs.every(j => j.status === "succeeded"));
  assert.equal(x.savedAutoSince(), x.records[0].archivedAt);
  const c = x.countSnapshots();
  x.service.scan(); await x.service.pump(); // 模拟 >15s 后的下一个周期
  c.restore();
  assert.equal(Object.keys(c.counts).length, 0);
  assert.equal(x.service.status().jobs.length, 2);
  assert.equal(x.savedAutoSince(), x.records[0].archivedAt);
 } finally { await x.cleanup(); }
});
test("a succeeded job with unchanged source is skipped without a snapshot", async () => {
 const x = setup(); try {
  await x.service.start();
  x.service.enqueue([x.records[0].id]); await x.service.pump();
  assert.equal(x.service.status().jobs.filter(j => j.recordingId === "rec1")[0].status, "succeeded");
  x.service.saveSettings({ autoBackup: true });
  const c = x.countSnapshots();
  x.service.scan(); await x.service.pump();
  c.restore();
  assert.equal(c.counts.analysis_rec1 || 0, 0);
  assert.equal(x.service.status().jobs.filter(j => j.recordingId === "rec1").length, 1);
  assert.equal(x.savedAutoSince(), x.records[0].archivedAt);
 } finally { await x.cleanup(); }
});
test("scan re-backups a recording after its source file changes", async () => {
 const x = setup(); try {
  await x.service.start();
  x.service.saveSettings({ autoBackup: true });
  x.service.scan(); await x.service.pump();
  assert.equal(x.service.status().jobs.length, 2);
  fs.appendFileSync(x.sources.rec1, " changed");
  const c = x.countSnapshots();
  x.service.scan(); await x.service.pump();
  c.restore();
  assert.equal(c.counts.analysis_rec1, 1); assert.equal(c.counts.analysis_rec2 || 0, 0);
  const jobs = x.service.status().jobs;
  assert.equal(jobs.length, 3);
  const rec1Jobs = jobs.filter(j => j.recordingId === "rec1");
  assert.deepEqual(rec1Jobs.map(j => j.status).sort(), ["stale_source", "succeeded"]);
 } finally { await x.cleanup(); }
});
test("a failing snapshot warns with the recordingId and does not block other recordings", async () => {
 const x = setup(); try {
  await x.service.start();
  x.service.saveSettings({ autoBackup: true });
  const original = store.load, warns = [], warn = console.warn;
  store.load = name => { if (name === "analysis_rec1") throw Error("字幕解析失败"); return original.call(store, name); };
  console.warn = (...args) => warns.push(args.join(" "));
  try { x.service.scan(); } finally { store.load = original; console.warn = warn; }
  await x.service.pump();
  const jobs = x.service.status().jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].recordingId, "rec2"); assert.equal(jobs[0].status, "succeeded");
  assert.ok(warns.some(w => w.includes("rec1") && w.includes("字幕解析失败")));
  assert.equal(x.savedAutoSince(), x.records[1].archivedAt);
 } finally { await x.cleanup(); }
});
