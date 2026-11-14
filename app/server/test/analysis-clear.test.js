"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48tools-clear-"));
process.env.DATA_DIR=path.join(root,"data");process.env.RECORDINGS_DIR=path.join(root,"recordings");fs.mkdirSync(process.env.RECORDINGS_DIR,{recursive:true});
const manager=require("../modules/recorder/manager"),service=require("../modules/analysis/service"),store=require("../lib/store");
test.after(()=>{service.stop();fs.rmSync(root,{recursive:true,force:true});});
function archived(){const file=path.join(process.env.RECORDINGS_DIR,`r${Math.random().toString(16).slice(2)}.m4a`);fs.writeFileSync(file,"x");return manager.addRecording({status:"done",filePath:file,mediaType:"audio"});}
function seed(id){
  store.atomicWrite(store.filePath(`analysis_${id}`),{segments:[{start:0,end:1,text:"你好",en:"Hi",translation:{$v:"en-v1",endpoint:"u",model:"m",instruction:"i"},enSource:"x"}],summary:"概述",summaryModel:"m",chapters:[{start:0,end:1,title:"t",summary:"s",evidenceIds:[0]}],highlights:[],correctedAt:"2026-01-01T00:00:00.000Z",correctionModel:"m",correctionEndpoint:"https://ai.test/v1",summaryEndpoint:"https://ai.test/v1",summarizedAt:"2026-01-01T00:00:00.000Z"});
}
test("clearing wipes derived text, keeps a snapshot and refuses for unknown recordings",async()=>{
  const rec=archived();seed(rec.id);
  store.atomicWrite(store.filePath("analysis_jobs"),[]);
  const before=store.load(`analysis_${rec.id}`,null);
  const after=service.clearAnalysis(rec.id);
  assert.deepEqual(after.segments,[]);assert.deepEqual(after.chapters,[]);assert.deepEqual(after.highlights,[]);
  for(const field of ["summary","summaryModel","summaryEndpoint","summarizedAt","correctedAt","correctionModel","correctionEndpoint"])assert.equal(after[field],undefined,field+" must not survive");
  assert.deepEqual(store.load(`analysis_${rec.id}_before_clear`,null),before,"the previous analysis is kept for accountability");
  assert.equal(store.load(`analysis_${rec.id}_before_clear`,null).segments[0].en,"Hi");
  assert.throws(()=>service.clearAnalysis("no-such-recording"),/归档不存在/);
  assert.throws(()=>service.clearAnalysis(rec.id),/还没有分析结果/,"a second clear has nothing left to do");
});
test("pending derived work keeps the stored analysis intact",async()=>{
  const rec=archived();seed(rec.id);
  const jobs=store.load("analysis_jobs",[]);jobs.push({id:"job-busy",recordingId:rec.id,kind:"summarize",status:"queued",createdAt:"2026-01-01T00:00:00.000Z"});store.atomicWrite(store.filePath("analysis_jobs"),jobs);
  // Whichever guard fires first (an owner refusing, or the derived-job check), the
  // stored result must still be there afterwards. That is the property that matters.
  let refused=false;
  try{service.clearAnalysis(rec.id);}catch(e){refused=true;assert.match(e.message,/请等待分析结束|分析 worker/);}
  assert.equal(refused,true,"clearing must be refused while derived work is pending");
  assert.equal(store.load(`analysis_${rec.id}`,null).segments.length,1,"nothing was wiped");
});
test("purging an archive removes its analysis result and every derived backup, never a similar id's data",()=>{
  const rec=archived();seed(rec.id);
  store.atomicWrite(store.filePath(`analysis_${rec.id}_before_correction`),{segments:[]});
  store.atomicWrite(store.filePath(`analysis_${rec.id}_summary_checkpoint`),{completed:[]});
  const other=archived();seed(other.id);
  const removed=service.purge(rec.id);
  assert.equal(removed,3);
  for(const name of [`analysis_${rec.id}`,`analysis_${rec.id}_before_correction`,`analysis_${rec.id}_summary_checkpoint`])assert.equal(fs.existsSync(store.filePath(name)),false,name+" must be removed");
  assert.ok(fs.existsSync(store.filePath(`analysis_${other.id}`)),"a similar id's analysis must never be touched");
  // 删除归档的路由必须级联调用清理。
  const source=fs.readFileSync(path.join(__dirname,"..","routes","recordings.js"),"utf8");
  assert.match(source,/purge\(recording\.id\)/,"the delete route must cascade the purge");
});
