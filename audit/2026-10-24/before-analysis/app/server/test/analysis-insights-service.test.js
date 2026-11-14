"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'insights-service-'));
process.env.DATA_DIR=root;
const file=path.join(root,'audio.mp4');fs.writeFileSync(file,'fixture');
// Isolate the queue integration from media binaries and recorder background services.
for(const [name,exports] of [
 ['../modules/recorder/manager',{getRecording:id=>({id,status:'done',filePath:file})}],
 ['../modules/recorder/archive-processor',{_internals:{resolveSource:()=>file}}],
 ['../modules/recorder/replay-recovery',{busy:()=>false}]
]){const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
const settings=require('../modules/analysis/settings'),store=require('../lib/store'),service=require('../modules/analysis/service');
const originalFetch=global.fetch;
const segments=[{start:0,end:10,text:'一'},{start:600,end:610,text:'二'}];
const old={segments,summary:'旧成功',chapters:[{start:0,end:1,title:'旧章',summary:'旧说明'}],highlights:[],fingerprint:'asr-untouched',completedSeconds:610};
function response(options){const batch=JSON.parse(JSON.parse(options.body).messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({summary:'新概述',chapters:batch.map(s=>({start:s.start,end:s.end,title:'主题',summary:'内容',evidenceIds:[s.id]})),highlights:[]})}}]});}
async function settled(id){const end=Date.now()+5000;while(service.busy(id)){if(Date.now()>end)throw Error('queue timeout');await new Promise(r=>setTimeout(r,5));}return service.result(id);}
test.after(()=>{service.stop();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
test('queue failure keeps old result, atomically checkpoints and manual retry commits whole success',async()=>{
 settings.save({ai:{url:'https://example.test/v1',model:'m',key:'test'}});settings.write('analysis_resume',old);
 // 分片内会重试，所以要让"这一段"持续失败才能验证失败路径：第 2 次起连续失败。
 let calls=0, failing=false;
 global.fetch=async(_url,options)=>{
   calls++;
   if(calls===2){assert.equal(store.load('analysis_resume_summary_checkpoint',null).completed.length,1);failing=true;}
   if(failing) return new Response('',{status:503});
   return response(options);
 };
 service.start();service.enqueue('resume','summarize');let out=await settled('resume');assert.equal(out.job.status,'failed');assert.equal(out.summary,'旧成功');assert.deepEqual(out.chapters,old.chapters);assert.equal(out.fingerprint,'asr-untouched');
 failing=false;
 service.enqueue('resume','summarize');out=await settled('resume');assert.equal(out.job.status,'done',out.job.error);
 // 分片内部有重试，HTTP 调用次数不再固定为 3；这里只校验最终产物正确。
 assert.ok(calls>=3);assert.equal(out.summary,'新概述\n\n新概述');assert.deepEqual(out.chapters.map(r=>r.evidenceIds),[[0],[1]]);assert.equal(out.summaryCoverage.complete,true);assert.equal(out.summaryModel,'m');assert.equal(out.fingerprint,'asr-untouched');
});
test('cancellation after a completed block preserves old successful result and retained checkpoint',async()=>{
 settings.write('analysis_cancel',old);let calls=0;
 global.fetch=async(_url,options)=>{calls++;if(calls===2)service.cancel('cancel');return response(options);};
 service.enqueue('cancel','summarize');let out=await settled('cancel');assert.equal(out.job.status,'failed');assert.equal(out.summary,'旧成功');assert.deepEqual(out.chapters,old.chapters);assert.equal(store.load('analysis_cancel_summary_checkpoint',null).completed.length,1);
 global.fetch=async(_url,options)=>{calls++;return response(options);};service.enqueue('cancel','summarize');out=await settled('cancel');assert.equal(out.job.status,'done',out.job.error);assert.equal(calls,3);
});
test('manual edit, original restore and correction clear derived summary metadata',async()=>{
 const seeded={...old,segments:segments.map(s=>({...s,originalText:s.text})),summaryCoverage:{complete:true},summaryModel:'old-model'};
 const check=out=>{assert.equal(out.summary,undefined);assert.equal(out.summaryCoverage,undefined);assert.equal(out.summaryModel,undefined);assert.deepEqual(out.chapters,[]);assert.deepEqual(out.highlights,[]);};
 settings.write('analysis_metadata',seeded);check(service.editSegment('metadata',0,'修改'));
 settings.write('analysis_metadata',seeded);check(service.restoreOriginal('metadata'));
 settings.write('analysis_metadata',seeded);
 global.fetch=async(_url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({corrections:input.segments.map(s=>({id:s.id,text:s.text}))})}}]});};
 service.enqueue('metadata','correct');const out=await settled('metadata');assert.equal(out.job.status,'done',out.job.error);check(out);
});
test('invalid evidence cannot replace prior summary and does not become resumable success',async()=>{
 settings.write('analysis_bad',old);global.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({summary:'伪造',chapters:[{start:0,end:10,title:'伪造',summary:'伪造',evidenceIds:[999]}],highlights:[]})}}]});
 service.enqueue('bad','summarize');const out=await settled('bad');assert.equal(out.job.status,'failed');assert.match(out.job.error,/引用/);assert.equal(out.summary,'旧成功');assert.equal(store.load('analysis_bad_summary_checkpoint',null),null);
});
