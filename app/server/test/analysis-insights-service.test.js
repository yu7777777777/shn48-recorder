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
test.after(async()=>{await service.stop();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
test('queue failure keeps old result, atomically checkpoints and manual retry commits whole success',async()=>{
 settings.save({ai:{url:'https://example.test/v1',model:'m',key:'test'}});settings.write('analysis_resume',old);
 // Fail the second chunk and verify that the provider is not called again internally.
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
 // Two initial requests plus only the failed chunk on manual retry.
 assert.equal(calls,3);assert.equal(out.summary,'新概述\n\n新概述');assert.deepEqual(out.chapters.map(r=>r.evidenceIds),[[0],[1]]);assert.equal(out.summaryCoverage.complete,true);assert.equal(out.summaryModel,'m');assert.equal(out.fingerprint,'asr-untouched');
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
test('F03: saving another endpoint without a key prevents enqueue before any provider request',()=>{
 settings.write('analysis_scope',old);
 let calls=0;global.fetch=async()=>{calls++;throw Error('must not reach provider');};
 try {
  settings.save({ai:{url:'https://new-service.example/v1'}});
  assert.equal(settings.publicSettings().ai.configured,false);
  assert.throws(()=>service.enqueue('scope','summarize'),/填写服务地址、模型和密钥/);
  assert.equal(calls,0);
 } finally {settings.save({ai:{url:'https://example.test/v1',model:'m',key:'test'}});}
});
test('F15: disabled queue retries issue exactly one HTTP request, including 401, 429 and 503',async()=>{
 settings.save({queue:{autoRetry:false,maxRetries:0}});
 for(const status of [401,429,503]) {
  const id='no-retry-'+status;settings.write('analysis_'+id,old);let calls=0;
  global.fetch=async()=>{calls++;return new Response('',{status,headers:{'Retry-After':'600'}});};
  service.enqueue(id,'summarize');const out=await settled(id);
  assert.equal(out.job.status,'failed');assert.equal(calls,1);assert.equal(out.job.retryCount,0);
  assert.equal(out.summary,'旧成功');
 }
});
test('F15: opted-in HTTP 401 still fails without scheduling or internal requests',async()=>{
 settings.save({queue:{autoRetry:true,maxRetries:1}});
 settings.write('analysis_no-retry-auth',old);let calls=0;
 global.fetch=async()=>{calls++;return new Response('',{status:401});};
 try {
  service.enqueue('no-retry-auth','summarize');const out=await settled('no-retry-auth');
  assert.equal(out.job.status,'failed');assert.equal(calls,1);assert.equal(out.job.retryCount,0);
  assert.equal(out.job.nextAttemptAt,undefined);
 } finally {settings.save({queue:{autoRetry:false,maxRetries:3}});}
});
test('F15: HTTP 429 is durable, obeys Retry-After and consumes exactly the queue retry budget',async()=>{
 await service._internals.idle();
 let now=1000000,calls=0;const timers=new Map();
 service._internals.setClock({now:()=>now,setTimer:(fn,ms)=>{const token={unref(){}};timers.set(token,{fn,at:now+ms});return token;},clearTimer:token=>timers.delete(token)});
 settings.save({queue:{autoRetry:true,maxRetries:1}});settings.write('analysis_rate-limit',old);
 global.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'600'}});};
 try {
  service.enqueue('rate-limit','summarize');
  await new Promise(resolve=>setImmediate(resolve));await service._internals.idle();
  let out=service.result('rate-limit');
  assert.equal(out.job.status,'queued');assert.equal(out.job.retryCount,1);assert.equal(out.job.attempts,1);assert.equal(calls,1);
  assert.equal(Date.parse(out.job.nextAttemptAt),now+600000);assert.equal(timers.size,1);
  const [token,timer]=[...timers][0];assert.equal(timer.at,now+600000);
  now+=599999;assert.equal(calls,1);assert.equal(out.summary,'旧成功');
  now++;timers.delete(token);timer.fn();await service._internals.idle();out=service.result('rate-limit');
  assert.equal(out.job.status,'failed');assert.equal(out.job.retryCount,1);assert.equal(out.job.attempts,2);assert.equal(calls,2);
  assert.equal(out.job.nextAttemptAt,undefined);assert.equal(timers.size,0);assert.equal(out.summary,'旧成功');
 } finally {
  await service._internals.idle();
  service._internals.setClock({now:Date.now,setTimer:setTimeout,clearTimer:clearTimeout});
  settings.save({queue:{autoRetry:false,maxRetries:3}});
 }
});
