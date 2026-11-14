"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { createService, safeTarget } = require("../modules/backup115/service");
const leases = require("../modules/backup115/leases");
function setup(options = {}) {
 const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup115-")), root = path.join(base, "recordings"), dir = path.join(base, "state"); fs.mkdirSync(root);
 const source = path.join(root, "one.mp4"); fs.writeFileSync(source, "a real source snapshot");
 const rec = { id: "recording1", status: "done", filePath: source, title: "测试直播", memberName: "成员A", recordedAt: "2026-10-20T08:00:00Z", archivedAt: "2026-10-20T08:00:00Z" };
 const records = [rec], calls = [];
 const provider = { invoke: async (command, input = {}, opts = {}) => {
  calls.push({ command, input });
  if (command === "check") return { runtimeAvailable: true, authorized: true, accountId: "100", accountLabel: "测试账号" };
  if (command === "upload") {
   await options.upload?.(input, opts);
   opts.onProgress?.({ phase: "verifying" });
   return { verified: true, accountId: "100", remote: { fileId: "12345678901234567890", parentId: "55", size: input.size, sha1: options.mismatch ? "WRONG" : input.sha1, path: input.remoteDir + "/" + input.filename } };
  }
  return {};
 }};
 const manager = { getRecording: id => records.find(r => r.id === id), getRecordings: () => records };
 const service = createService({ root, dir, manager, provider, leases, stable: () => {}, write: options.write });
 service._internals.setConnection({ runtimeAvailable: true, authorized: true, accountId: "100" });
 return { service, base, root, dir, source, rec, records, calls, provider, manager, cleanup: async () => { await service.stop(); for(const j of service._internals.getJobs())leases.releaseOwner(j.id); fs.rmSync(base,{recursive:true,force:true}); } };
}
test("backup is independent, idempotent and only succeeds after hash verification", async () => {
 const x = setup(); try {
  const first = x.service.enqueue([x.rec.id]).jobs[0]; assert.equal(first.status,"queued");
  assert.equal(x.service.enqueue([x.rec.id]).jobs[0].id, first.id);
  assert.equal(leases.lockedPath(x.source),true);
  await x.service.start(); await x.service.pump();
  const result=x.service.status().jobs[0]; assert.equal(result.status,"succeeded"); assert.equal(result.progress,100); assert.ok(result.verifiedAt);
  assert.equal(result.files.length,2); assert.ok(result.files.every(f=>f.status==='succeeded'));
  assert.equal(x.rec.uploadStatus,undefined); assert.ok(fs.existsSync(x.source)); assert.equal(leases.lockedPath(x.source),false);
  assert.equal(result.files[0].remoteFileId,"12345678901234567890");
  const wire=JSON.stringify(x.service.status());assert.ok(!wire.includes(x.source));assert.ok(!wire.includes('accountId'));
  assert.equal(x.calls.filter(c=>c.command==='upload').length,2);
 } finally { await x.cleanup(); }
});
test("bad remote hashes cannot mark success and never delete the original", async()=>{
 const x=setup({mismatch:true});try{ x.service.enqueue([x.rec.id]);await x.service.start();await x.service.pump();assert.equal(x.service.status().jobs[0].status,'failed');assert.ok(fs.existsSync(x.source));assert.equal(x.service.status().jobs[0].verifiedAt,null); }finally{await x.cleanup();}
});
test("changing the source while queued marks the old job stale",async()=>{
 const x=setup();try{x.service.enqueue([x.rec.id]);fs.appendFileSync(x.source,' changed');await x.service.start();await x.service.pump();assert.equal(x.service.status().jobs[0].status,'stale_source');assert.equal(x.calls.filter(c=>c.command==='upload').length,0);}finally{await x.cleanup();}
});
test("cancel aborts active provider and late results cannot resurrect a job",async()=>{
 let arrived;const entered=new Promise(r=>arrived=r);
 const x=setup({upload:(_,opts)=>new Promise((resolve,reject)=>{arrived();opts.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'cancelled'})),{once:true});})});
 try{const j=x.service.enqueue([x.rec.id]).jobs[0];void x.service.start();await entered;x.service.cancel(j.id);await x.service.pump();assert.equal(x.service.status().jobs[0].status,'cancelled');assert.equal(leases.lockedPath(x.source),false);assert.ok(fs.existsSync(x.source));}finally{await x.cleanup();}
});
test("network errors retry, authentication failures pause, attachment failures stay partial",async()=>{
 for(const code of ['network','unauthorized','mismatch']){
  const x=setup({upload:input=>{if(code!=='mismatch'||input.filename.includes('metadata'))throw Object.assign(Error('secret response must not leak'),{code});}});
  try{x.service.enqueue([x.rec.id]);await x.service.start();await x.service.pump();const j=x.service.status().jobs[0];assert.equal(j.status,{network:'retry_wait',unauthorized:'waiting_credentials',mismatch:'partial'}[code]);assert.ok(!JSON.stringify(j).includes('secret'));assert.ok(fs.existsSync(x.source));}finally{await x.cleanup();}
 }
});
test("corrupt state fails closed and settings cannot contain credentials or traversal",async()=>{
 const x=setup();try{
  for(const target of ['/', '/../secrets','/a/../b','/a\\b'])assert.throws(()=>safeTarget(target));
  assert.throws(()=>x.service.saveSettings({cookie:'do not save'}));
  assert.equal(x.service.saveSettings({targetPath:'/备份/成员',autoBackup:false}).targetPath,'/备份/成员');
  fs.mkdirSync(x.dir,{recursive:true});fs.writeFileSync(path.join(x.dir,'jobs.json'),'{broken');
  const second=createService({root:x.root,dir:x.dir,manager:x.manager,provider:x.provider,leases,stable:()=>{}});
  assert.throws(()=>second.status(),/损坏/);assert.equal(fs.readFileSync(path.join(x.dir,'jobs.json'),'utf8'),'{broken');
 }finally{await x.cleanup();}
});
test("state-write failure cannot publish success",async()=>{
 const atomic=require('../lib/store').atomicWrite;
 const x=setup({write:(file,value)=>{if(Array.isArray(value)&&value.some(j=>j.status==='succeeded'))throw Error('disk full');return atomic(file,value);}});
 try{x.service.enqueue([x.rec.id]);await x.service.start();await x.service.pump();assert.notEqual(x.service.status().jobs[0].status,'succeeded');assert.ok(fs.existsSync(x.source));}finally{await x.cleanup();}
});
test("cancelled jobs retry as a new snapshot and new file versions never inherit old success",async()=>{
 const x=setup();try{const first=x.service.enqueue([x.rec.id]).jobs[0];x.service.cancel(first.id);const retry=x.service.retry(first.id);assert.notEqual(retry.id,first.id);await x.service.start();await x.service.pump();assert.equal(x.service.status().jobs.at(-1).status,"succeeded");fs.appendFileSync(x.source," new version");assert.equal(x.service.status().jobs.at(-1).status,"stale_source");const latest=x.service.retry(retry.id);assert.notEqual(latest.id,retry.id);await x.service.pump();assert.equal(x.service.status().jobs.at(-1).status,"succeeded");}finally{await x.cleanup();}
});
test("automatic backup only queues new archives and does not undo explicit cancellation",async()=>{
 const x=setup();try{x.service.saveSettings({autoBackup:true});await x.service.start();x.service.scan();await x.service.pump();assert.equal(x.service.status().jobs.length,0);x.rec.archivedAt=new Date(Date.now()+1000).toISOString();x.service.scan();const first=x.service.status().jobs[0];assert.ok(first);x.service.cancel(first.id);x.service.scan();await x.service.pump();assert.equal(x.service.status().jobs.length,1);assert.equal(x.service.status().jobs[0].status,"cancelled");}finally{await x.cleanup();}
});
test("server restart recovers persisted jobs and rechecks cloud ids",async()=>{
 const x=setup();try{x.service.enqueue([x.rec.id]);const persisted=x.service._internals.getJobs();persisted[0].status='uploading';fs.writeFileSync(path.join(x.dir,'jobs.json'),JSON.stringify(persisted));
 const second=createService({root:x.root,dir:x.dir,manager:x.manager,provider:x.provider,leases,stable:()=>{}});await second.start();await second.pump();assert.equal(second.status().jobs[0].status,'succeeded');await second.stop();
 }finally{await x.cleanup();}
});
