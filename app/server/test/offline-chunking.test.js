const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'offline-chunk-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');process.env.ASR_CHUNK_SECONDS='60';fs.mkdirSync(process.env.RECORDINGS_DIR);
const service=require('../modules/analysis/service'),settings=require('../modules/analysis/settings'),manager=require('../modules/recorder/manager'),offline=require('../modules/analysis/offline'),store=require('../lib/store'),exporter=require('../modules/analysis/export');
const originalTranscribe=offline.transcribe;
const modelDir=path.join(process.env.DATA_DIR,'asr-models','tiny');fs.mkdirSync(modelDir,{recursive:true});fs.writeFileSync(path.join(modelDir,'.ready'),'test');
test.after(()=>{service.stop();offline.transcribe=originalTranscribe;fs.rmSync(root,{recursive:true,force:true});});
async function waitFor(fn,label){const end=Date.now()+30000;while(!fn()){assert.ok(Date.now()<end,'timeout: '+(label||''));await new Promise(r=>setTimeout(r,20));}}
async function settled(id){await waitFor(()=>!service.busy(id),`job ${id} settles`);return service.result(id);}
function longRecording(name,seconds){const file=path.join(process.env.RECORDINGS_DIR,name);const gen=spawnSync(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440','-t',String(seconds),'-c:a','aac',file]);assert.equal(gen.status,0,gen.stderr?.toString());return manager.addRecording({status:'done',filePath:file,mediaType:'audio'});}
// 离线转写 mock：每次调用挂起等待放行，便于逐块断言落盘进度与续跑范围。
function gatedMock(outputs){const calls=[],pending=[];
 offline.transcribe=async(file,model,prompt,signal)=>{calls.push({file,model,prompt});const index=calls.length-1;await new Promise(r=>pending.push(r));const output=outputs[index];return typeof output==='function'?output():output;};
 return {calls,pending:()=>pending.length,release:()=>pending.shift()()};}
test('离线识别按块转写长录像：每块落盘进度、指纹变化前备份旧字幕、完成时记录溯源，且不构造 multipart',async()=>{
 const rec=longRecording('long-a.m4a',180);
 settings.save({offline:{enabled:true,model:'tiny'},glossary:[{term:'徐佳琪',aliases:'佳琪',enabled:true}]});
 // SRT 导入的记录没有指纹：重新识别前必须先备份，不能静默清空。
 settings.write(`analysis_${rec.id}`,{segments:[{start:0,end:1,text:'导入句'}],chapters:[],highlights:[],source:'srt',complete:true});
 let forms=0,blobs=0;const RealFormData=global.FormData,RealBlob=global.Blob;
 global.FormData=class{constructor(){forms++;}};global.Blob=class{constructor(){blobs++;}};
 try {
  const mock=gatedMock([()=>({segments:[{start:0,end:5,text:'块1'}]}),()=>({segments:[{start:0,end:5,text:'块2'}]}),()=>({segments:[{start:0,end:5,text:'块3'}]})]);
  service.start();service.enqueue(rec.id,'transcribe');
  await waitFor(()=>mock.pending()===1,'chunk 1 reaches transcribe');
  assert.equal(mock.calls.length,1);assert.match(mock.calls[0].prompt,/徐佳琪/);
  assert.equal(store.load(`analysis_${rec.id}`).completedSeconds||0,0,'识别中不得提前落盘进度');
  mock.release();
  await waitFor(()=>store.load(`analysis_${rec.id}`).completedSeconds===60,'chunk 1 persisted');
  assert.equal(store.load(`analysis_${rec.id}`).segments.length,1);
  await waitFor(()=>mock.pending()===1,'chunk 2 reaches transcribe');
  const p1=service.result(rec.id).job.progress;assert.ok(p1>0&&p1<100,'第 1 块后进度应可见: '+p1);
  mock.release();
  await waitFor(()=>store.load(`analysis_${rec.id}`).completedSeconds===120,'chunk 2 persisted');
  assert.equal(store.load(`analysis_${rec.id}`).segments.length,2);
  await waitFor(()=>mock.pending()===1,'chunk 3 reaches transcribe');
  const p2=service.result(rec.id).job.progress;assert.ok(p2>p1&&p2<100,'进度必须逐块递增');
  mock.release();
  const out=await settled(rec.id);
  assert.equal(out.job.status,'done',out.job.error);assert.equal(mock.calls.length,3);
  assert.deepEqual(out.segments.map(s=>s.text),['块1','块2','块3']);
  assert.equal(out.complete,true);assert.equal(out.job.progress,100);
  // 指纹变化清空前，旧字幕必须有备份。
  assert.equal(store.load(`analysis_${rec.id}_before_retranscribe`,null)?.segments[0].text,'导入句');
  // 完成时写入溯源，导出的「语音识别」阶段不再是信息不全。
  assert.ok(out.transcribedAt);assert.deepEqual(out.glossary,['徐佳琪']);
  assert.equal(exporter.provenance(out).stages[0].status,'recorded');
 } finally { global.FormData=RealFormData;global.Blob=RealBlob; }
 assert.equal(forms,0);assert.equal(blobs,0,'offline 模式不得构造 FormData/Blob');
});
test('第 2 块失败后重试从第 2 块开始，已完成块的 segments 保留',async()=>{
 const rec=longRecording('long-b.m4a',180);
 let calls=0;const pending=[];
 offline.transcribe=async(file,model,prompt,signal)=>{calls++;await new Promise(r=>pending.push(r));if(calls===2)throw new Error('离线识别失败');return {segments:[{start:0,end:5,text:'段'+calls}]};};
 service.enqueue(rec.id,'transcribe');
 await waitFor(()=>pending.length===1,'chunk 1');pending.shift()();
 await waitFor(()=>pending.length===1,'chunk 2');pending.shift()();
 await settled(rec.id);
 const failed=service.result(rec.id);
 assert.equal(failed.job.status,'failed');
 assert.deepEqual(failed.segments.map(s=>s.text),['段1']);assert.equal(failed.completedSeconds,60);
 service.enqueue(rec.id,'transcribe');
 await waitFor(()=>pending.length===1,'retry chunk 2');pending.shift()();
 await waitFor(()=>pending.length===1,'retry chunk 3');pending.shift()();
 const out=await settled(rec.id);
 assert.equal(out.job.status,'done',out.job.error);
 assert.equal(calls,4,'只有未完成的第 2、3 块重新识别');
 assert.deepEqual(out.segments.map(s=>s.text),['段1','段3','段4']);
 assert.equal(out.complete,true);assert.ok(out.transcribedAt);
});
