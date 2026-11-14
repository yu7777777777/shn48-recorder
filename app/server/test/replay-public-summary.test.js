"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48pub-sum-"));
process.env.DATA_DIR=path.join(root,"data");process.env.RECORDINGS_DIR=path.join(root,"recordings");fs.mkdirSync(process.env.RECORDINGS_DIR,{recursive:true});
const manager=require("../modules/recorder/manager"),service=require("../modules/analysis/service"),store=require("../lib/store"),replay=require("../modules/pocket48/replay"),settings=require("../modules/analysis/settings");
test.before(()=>settings.save({publish:{summary:true,chapters:true,highlights:true}}));
const original=replay.getReplay;
test.after(()=>{replay.getReplay=original;service.stop();fs.rmSync(root,{recursive:true,force:true});});
// The 404 case restores the switch itself: node:test may start these tests
// concurrently, so a shared afterEach could turn the switch back on mid-test.
// Public replay only ever exists for the video archive; audio sessions never publish
// a shared link, so the fixture mirrors that.
function archived(liveId){const file=path.join(process.env.RECORDINGS_DIR,`r${Math.random().toString(16).slice(2)}.mp4`);fs.writeFileSync(file,"x");return manager.addRecording({status:"done",filePath:file,mediaType:"video",source:"pocket48",liveId});}
async function call(liveId){const app=require("express")();app.use("/api/public",require("../routes/public"));const server=http.createServer(app);await new Promise(r=>server.listen(0,"127.0.0.1",r));try{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/public/replays/${liveId}/summary`);return {status:res.status,type:res.headers.get("content-type"),cache:res.headers.get("cache-control"),body:await res.json().catch(()=>null)};}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
function seed(id){store.atomicWrite(store.filePath(`analysis_${id}`),{segments:[{start:0,end:2,text:"你好"}],summary:"这是公开总结",chapters:[{start:0,end:2,title:"开场",summary:"开场内容",evidenceIds:[0]}],highlights:[],summaryModel:"m",summaryEndpoint:"https://ai.example.com/v1?key=sk-leak"});}
test("a public replay summary is a whitelist DTO without model, endpoint or segment text",async()=>{
 const rec=archived("900001");seed(rec.id);
 replay.getReplay=async()=>({replay:{liveId:"900001"}});
 const res=await call("900001");
 assert.equal(res.status,200);assert.equal(res.cache,"public, max-age=60");
 const text=JSON.stringify(res.body);
 assert.equal(res.body.data.summary,"这是公开总结");
 assert.equal(res.body.data.chapters[0].title,"开场");
 assert.equal(text.includes("sk-leak"),false,"the endpoint never leaves the server");
 assert.equal(text.includes("ai.example.com"),false);
 assert.equal(text.includes("summaryModel"),false,"no model field in the public shape");
 assert.equal(text.includes("你好"),false,"subtitle text is not published by this endpoint");
 assert.equal(res.body.data.recordingId,rec.id,"the page needs the archive id to request the subtitle track explicitly");
});
test("without a summary the endpoint says so instead of returning an empty page",async()=>{
 const rec=archived("900002");
 replay.getReplay=async()=>({replay:{liveId:"900002"}});
 const missing=await call("900002");
 assert.equal(missing.status,404);assert.equal(missing.body.success,false);
 store.atomicWrite(store.filePath(`analysis_${rec.id}`),{segments:[{start:0,end:2,text:"你好"}]});
 const noSummary=await call("900002");
 assert.equal(noSummary.status,404,"segments without a summary are not a public summary");
});
test("an archive that is not finished is not published",async()=>{
 const rec=archived("900003");seed(rec.id);
 manager.updateRecording(rec.id,{status:"recording"});
 replay.getReplay=async()=>({replay:{liveId:"900003"}});
 const res=await call("900003");
 assert.equal(res.status,404);
});
test("turning the public summary off hides it even when one exists",async()=>{
 const rec=archived("900004");seed(rec.id);
 settings.save({publish:{summary:false}});
 try {
  replay.getReplay=async()=>({replay:{liveId:"900004"}});
 const res=await call("900004");
  assert.equal(res.status,404,"an explicit switch beats an existing summary");
 } finally { settings.save({publish:{summary:true}}); }
});
test("chapters and highlights are published only when their switches are on",async()=>{
 settings.save({publish:{summary:true,chapters:false,highlights:false}});
 try {
  const rec=archived("900005");
  // Seed after the switch is set so nothing can observe a half-configured state.
  store.atomicWrite(store.filePath(`analysis_${rec.id}`),{segments:[{start:0,end:2,text:"你好"}],summary:"这是公开总结",chapters:[{start:0,end:2,title:"开场",summary:"开场内容"}],highlights:[{start:0,end:2,title:"高光",summary:"高光内容"}]});
  replay.getReplay=async()=>({replay:{liveId:"900005"}});
  const off=await call("900005");
  assert.equal(off.status,200);
  assert.equal(off.body.data.summary,"这是公开总结","the summary itself stays published");
  assert.deepEqual(off.body.data.chapters,[]);assert.deepEqual(off.body.data.highlights,[]);
  settings.save({publish:{chapters:true,highlights:true}});
  const on=await call("900005");
  assert.equal(on.body.data.chapters.length,1);assert.equal(on.body.data.highlights.length,1);
 } finally { settings.save({publish:{summary:true,chapters:true,highlights:true}}); }
});test("chapters-only mode publishes titles and times without the prose",async()=>{
 settings.save({publish:{summary:true,chapters:true,highlights:true},publicDetail:{mode:"chapters"}});
 try {
  const rec=archived("900006");
  store.atomicWrite(store.filePath(`analysis_${rec.id}`),{segments:[{start:0,end:2,text:"你好"}],summary:"这是公开总结",chapters:[{start:0,end:2,title:"开场",summary:"开场内容"}],highlights:[{start:0,end:2,title:"高光",summary:"高光内容"}]});
  replay.getReplay=async()=>({replay:{liveId:"900006"}});
  const res=await call("900006");
  assert.equal(res.status,200);
  assert.equal(res.body.data.detail,"chapters");
  assert.equal(res.body.data.summary,"","the prose is withheld in this mode");
  assert.equal(res.body.data.chapters[0].title,"开场");
  assert.equal(res.body.data.chapters[0].summary,"开场内容","chapter captions stay, they are the point of this mode");
  assert.equal(JSON.stringify(res.body).includes("这是公开总结"),false);
 } finally { settings.save({publicDetail:{mode:"full"},publish:{summary:true,chapters:true,highlights:true}}); }
});
 