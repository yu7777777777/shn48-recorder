const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-audit-test-"));
process.env.DATA_DIR = data;
process.env.RECORDINGS_DIR = path.join(data, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
const manager = require("../modules/recorder/manager");
const replay = require("../modules/pocket48/replay");
const media = require("../modules/recorder/replay-download");
const audit = require("../modules/recorder/replay-audit");
const pocket48 = require("../modules/pocket48/api");

test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test("audit finds official duration by exact live ID in the member replay list", async () => {
  const original = pocket48.getReplayListPage;
  let calls = 0;
  pocket48.getReplayListPage = async ({ userId } = {}) => {
    calls += 1;
    const liveList = userId
      ? [{ liveId: "987659", duration: "02:33:57", userInfo: { userId: "64422010" } }]
      : [{ liveId: "987660", duration: "00:01:00", userInfo: { userId: "1" } }];
    return { status: 200, data: { status: 200, content: { liveList, next: "0" } } };
  };
  try {
    const found = await replay.findReplayMetadata("987659", "64422010");
    assert.equal(found.durationSeconds, 9237);
    assert.equal(found.liveId, "987659");
    assert.equal(calls, 2);
    assert.equal(await replay.findReplayMetadata("987658", "64422010"), null);
  } finally { pocket48.getReplayListPage = original; }
});

test("historical audit classifies a posted 1498s recording against a 9237s replay", async () => {
  const originalReplay = replay.findReplayMetadata;
  const originalProbe = media.probe;
  const file = path.join(process.env.RECORDINGS_DIR, "short.mp4");
  fs.writeFileSync(file, "fixture");
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987654", mediaType: "video", filePath: file, durationSeconds: 1498, uploadStatus: "done", draftId: "draft-1", title: "posted short" });
  replay.findReplayMetadata = async () => ({ liveId: rec.liveId, durationSeconds: 9237 });
  media.probe = async () => ({ format: { duration: "1498" }, streams: [{ codec_type: "video" }] });
  try {
    const result = await audit.inspect(rec);
    assert.equal(result.status, "published_needs_repair");
    assert.equal(result.localSeconds, 1498);
    assert.equal(result.officialSeconds, 9237);
    assert.equal(result.posted, true);
  } finally { replay.findReplayMetadata = originalReplay; media.probe = originalProbe; }
});

test("audit immediately queues a confirmed gap after legacy lookup backoff, including a previously rescanned item", async () => {
  const originalReplay = replay.findReplayMetadata;
  const originalProbe = media.probe;
  replay.findReplayMetadata = async () => ({ durationSeconds: 9237 });
  media.probe = async () => ({ format: { duration: "1498" } });
  try {
    for (const [index, status] of ["temporary_error", "official_unavailable", "published_needs_repair"].entries()) {
      const file = path.join(process.env.RECORDINGS_DIR, `lookup-backoff-${index}.mp4`);
      fs.writeFileSync(file, "fixture");
      const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: `98767${index}`, mediaType: "video", filePath: file, uploadStatus: "done" });
      const stale = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      audit._internals.records.set(String(rec.id), { status, reason: status === "published_needs_repair" ? "B站已有投稿，仅修复本地归档，不改投稿" : "官方回放查询临时失败，稍后自动重试", error: "上游查询暂时失败", attempts: 3, nextAttemptAt: stale });
      const before = Date.now();
      const result = await audit.inspect(rec);
      assert.equal(result.status, "published_needs_repair");
      assert.ok(Date.parse(result.nextAttemptAt) >= before && Date.parse(result.nextAttemptAt) <= Date.now());
      assert.equal(result.attempts, 0);
      assert.equal(result.retryType, null);
      assert.equal(result.error, null);
    }
  } finally { replay.findReplayMetadata = originalReplay; media.probe = originalProbe; }
});

test("audit preserves real repair failure backoff across repeated scans and a transient lookup failure", async () => {
  const originalReplay = replay.findReplayMetadata;
  const originalProbe = media.probe;
  const originalDownload = media.downloadShared;
  const file = path.join(process.env.RECORDINGS_DIR, "repair-backoff.mp4");
  fs.writeFileSync(file, "fixture");
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987674", mediaType: "video", filePath: file, uploadStatus: "done" });
  replay.findReplayMetadata = async () => ({ durationSeconds: 9237 });
  media.probe = async () => ({ format: { duration: "1498" }, streams: [{ codec_type: "video" }] });
  media.downloadShared = async () => { throw new Error("模拟下载失败"); };
  try {
    await audit.inspect(rec);
    const failed = await audit.repair(rec.id);
    assert.equal(failed.status, "published_needs_repair");
    assert.equal(failed.retryType, "repair");
    assert.ok(Date.parse(failed.nextAttemptAt) > Date.now());
    const checked = await audit.inspect(rec);
    assert.equal(checked.nextAttemptAt, failed.nextAttemptAt);
    assert.equal(checked.attempts, failed.attempts);
    assert.equal(checked.error, "模拟下载失败");
    replay.findReplayMetadata = async () => { throw new Error("上游断开"); };
    const unavailable = await audit.inspect(rec);
    assert.equal(unavailable.status, "temporary_error");
    assert.equal(unavailable.retryType, "repair");
    assert.equal(unavailable.nextAttemptAt, failed.nextAttemptAt);
    replay.findReplayMetadata = async () => ({ durationSeconds: 9237 });
    const recovered = await audit.inspect(rec);
    assert.equal(recovered.nextAttemptAt, failed.nextAttemptAt);
    assert.equal(recovered.attempts, failed.attempts);
    assert.equal(recovered.error, "模拟下载失败");
  } finally { replay.findReplayMetadata = originalReplay; media.probe = originalProbe; media.downloadShared = originalDownload; }
});

test("posted detection includes completed queue entries without enabling reupload", () => {
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987655", mediaType: "video" });
  manager.enqueueUpload({ recordingId: rec.id, status: "done" });
  assert.equal(audit._internals.posted(rec), true);
});

test("audit follows archive lifecycle and refuses repair after archive deletion", () => {
  const file = path.join(process.env.RECORDINGS_DIR, "prune-me.mp4");
  fs.writeFileSync(file, "fixture");
  const deleted = manager.addRecording({ source: "pocket48", status: "done", liveId: "987658", mediaType: "video", filePath: file });
  audit._internals.records.set(deleted.id, { recordingId: deleted.id, status: "repairable", updatedAt: new Date().toISOString() });
  manager.updateRecording(deleted.id, { status: "deleted", filePath: null });
  assert.equal(audit.summary().items.some(item => item.recordingId === deleted.id), false);
  assert.throws(() => audit.repair(deleted.id), error => error.statusCode === 404);

  const missingFile = path.join(process.env.RECORDINGS_DIR, "missing-prune.mp4");
  const missing = manager.addRecording({ source: "pocket48", status: "done", liveId: "987659", mediaType: "video", filePath: missingFile });
  audit._internals.records.set(missing.id, { recordingId: missing.id, status: "manual", updatedAt: new Date().toISOString() });
  assert.equal(audit.summary().items.some(item => item.recordingId === missing.id), false);
  manager.updateRecording(missing.id, { status: "merged" });
  audit._internals.records.set(missing.id, { recordingId: missing.id, status: "manual", updatedAt: new Date().toISOString() });
  assert.equal(audit.summary().items.some(item => item.recordingId === missing.id), false);
});

test("posted repair updates only local archive version and preserves Bilibili draft", async () => {
  const originalReplay = replay.findReplayMetadata;
  const originalProbe = media.probe;
  const originalDownload = media.downloadShared;
  const file = path.join(process.env.RECORDINGS_DIR, "posted-short.mp4");
  const officialFile = path.join(process.env.RECORDINGS_DIR, ".official-replays", "987656", "verified.mp4");
  fs.mkdirSync(path.dirname(officialFile), { recursive: true });
  fs.writeFileSync(file, "local"); fs.writeFileSync(officialFile, "official");
  const sha256 = crypto.createHash("sha256").update("official").digest("hex");
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987656", mediaType: "video", filePath: file, durationSeconds: 1498, uploadStatus: "done", draftId: "draft-2", title: "posted repair" });
  replay.findReplayMetadata = async () => ({ liveId: rec.liveId, durationSeconds: 9237 });
  media.probe = async target => ({ format: { duration: String(target === file ? 1498 : 9237) }, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] });
  media.downloadShared = async () => ({ filePath: officialFile, durationSeconds: 9237, size: fs.statSync(officialFile).size, sha256, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] });
  try {
    await audit.inspect(rec);
    await audit.repair(rec.id);
    const current = manager.getRecording(rec.id);
    assert.equal(current.draftId, "draft-2");
    assert.equal(current.filePath, officialFile);
    assert.equal(current.archiveOrigin, "official_replay");
    assert.ok(current.archiveVersion >= 1);
    assert.equal(current.fileSha256, sha256);
    assert.equal(current.replayRecovery.status, "replaced");
    assert.equal(current.replayAudit.status, "repaired_local_published");
    assert.equal(fs.existsSync(path.join(path.dirname(officialFile), `audit-before-${rec.id}.json`)), true);
  } finally { replay.findReplayMetadata = originalReplay; media.probe = originalProbe; media.downloadShared = originalDownload; }
});


test("unposted autoUpload repair queues exactly one Bilibili draft after replacement", async () => {
  const originalReplay = replay.findReplayMetadata, originalProbe = media.probe, originalDownload = media.downloadShared;
  const file = path.join(process.env.RECORDINGS_DIR, "auto-short.mp4"), officialFile = path.join(process.env.RECORDINGS_DIR, ".official-replays", "987657", "verified.mp4");
  fs.mkdirSync(path.dirname(officialFile), { recursive: true }); fs.writeFileSync(file, "local-auto"); fs.writeFileSync(officialFile, "official-auto");
  const sha256 = crypto.createHash("sha256").update("official-auto").digest("hex");
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987657", mediaType: "video", filePath: file, durationSeconds: 100, autoUpload: true, title: "auto repair" });
  replay.findReplayMetadata = async () => ({ liveId: rec.liveId, durationSeconds: 900 });
  media.probe = async target => ({ format: { duration: String(target === file ? 100 : 900) }, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] });
  media.downloadShared = async () => ({ filePath: officialFile, durationSeconds: 900, size: fs.statSync(officialFile).size, sha256, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] });
  try { await audit.inspect(rec); await audit.repair(rec.id); assert.equal(manager.getQueue().filter(item => item.recordingId === rec.id).length, 1); }
  finally { replay.findReplayMetadata = originalReplay; media.probe = originalProbe; media.downloadShared = originalDownload; }
});

test("a short legacy cache is refreshed once; a genuinely short official source stops automatic retries", async () => {
  const originalReplay = replay.findReplayMetadata, originalProbe = media.probe, originalDownload = media.downloadShared;
  const file = path.join(process.env.RECORDINGS_DIR, "official-still-short.mp4");fs.writeFileSync(file, "local");
  const rec = manager.addRecording({ source: "pocket48", status: "done", liveId: "987680", mediaType: "video", filePath: file, uploadStatus: "done" });
  replay.findReplayMetadata = async () => ({ durationSeconds: 600 });
  media.probe = async () => ({ format: { duration: "370" }, streams: [{ codec_type: "video", width: 540, height: 960 }] });
  const calls=[];
  media.downloadShared=async options=>{calls.push(options);return {durationSeconds:371, timelineVersion:options.refresh?1:undefined, streams:[{codec_type:"video",width:540,height:960}]};};
  try {
    await audit.inspect(rec);const r=await audit.repair(rec.id);
    assert.equal(calls.length,2);assert.equal(calls[1].refresh,true);
    assert.equal(calls[1].directory,path.join(calls[0].directory,"audit-timeline-v1"));
    assert.notEqual(calls[0].directory,calls[1].directory);
    assert.equal(r.status,"manual");assert.equal(r.nextAttemptAt,null);
    assert.match(r.error,/600\.00.*371\.00.*370\.00/);
    assert.equal(manager.getRecording(rec.id).filePath,file);
    const rechecked=await audit.inspect(rec);
    assert.equal(rechecked.status,"manual");assert.equal(rechecked.nextAttemptAt,null);assert.equal(rechecked.error,r.error);
  } finally { replay.findReplayMetadata=originalReplay;media.probe=originalProbe;media.downloadShared=originalDownload; }
});

test("explicit manual repair normalizes the available source and reports its limit without changing the original", async () => {
  const originalReplay=replay.findReplayMetadata, originalProbe=media.probe, originalDownload=media.downloadShared;
  const dir=path.join(process.env.RECORDINGS_DIR,".official-replays","987681");fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,"verified.mp4"),candidate=path.join(dir,"audit-timeline-v1","verified.mp4");fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.writeFileSync(file,"original");fs.writeFileSync(candidate,"normalized");
  const rec=manager.addRecording({source:"pocket48",status:"done",liveId:"987681",mediaType:"video",filePath:file,uploadStatus:"done",draftId:"keep-draft"});
  replay.findReplayMetadata=async()=>({durationSeconds:600});
  const streams=[{codec_type:"video",width:540,height:960},{codec_type:"audio"}];media.probe=async()=>({format:{duration:"370"},streams});
  media.downloadShared=async options=>({filePath:options.refresh?candidate:file,durationSeconds:options.refresh?371:370,verification:"full",timelineVersion:options.refresh?1:undefined,size:10,sha256:await media.digest(options.refresh?candidate:file),streams});
  try {
    await audit.inspect(rec);const r=await audit.repair(rec.id,{force:true});
    assert.equal(r.status,"repaired_source_limited_published");assert.equal(r.listedOfficialSeconds,600);assert.equal(r.officialSeconds,371);assert.equal(r.error,null);
    assert.equal(manager.getRecording(rec.id).filePath,candidate);assert.equal(manager.getRecording(rec.id).draftId,"keep-draft");assert.equal(fs.readFileSync(file,"utf8"),"original");
    assert.equal((await audit.inspect(manager.getRecording(rec.id))).status,r.status);
  } finally {replay.findReplayMetadata=originalReplay;media.probe=originalProbe;media.downloadShared=originalDownload;}
});
