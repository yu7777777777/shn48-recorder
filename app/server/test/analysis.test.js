"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'48tools-analysis-test-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');process.env.ASR_CHUNK_SECONDS='600';process.env.ASR_CONCURRENCY='1';fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager=require('../modules/recorder/manager'),service=require('../modules/analysis/service'),settings=require('../modules/analysis/settings');
const originalFetch=global.fetch;
test.after(()=>{service.stop();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
async function settled(id){const end=Date.now()+30000;while(service.busy(id)){if(Date.now()>end)throw new Error('Timeout');await new Promise(r=>setTimeout(r,20));}return service.result(id);}
test('settings never expose keys, preserve blanks, reject invalid endpoints and clear explicitly',()=>{
 settings.save({asr:{url:'https://example.test/v1',model:'whisper-1',key:'private-key'}});
 assert.equal(JSON.stringify(settings.publicSettings()).includes('private-key'),false);
 settings.save({asr:{key:''}});assert.equal(settings.get().asr.key,'private-key');
 assert.throws(()=>settings.save({ai:{url:'file:///example.test'}}));
 settings.save({asr:{clearKey:true}});assert.equal(settings.publicSettings().asr.configured,false);
});
test('model discovery uses stored credentials without saving drafts or leaking keys',async()=>{
 settings.save({asr:{url:'https://models.test/v1',model:'old-model',key:'model-secret'}});
 let calls=0;
 global.fetch=async(url,options)=>{calls++;assert.equal(url,'https://models.test/v1/models');assert.equal(options.headers.Authorization,'Bearer model-secret');assert.equal(options.redirect,'error');return Response.json({data:[{id:'z'},{id:'a'},{id:'a'},{bad:'ignored'}]});};
 assert.deepEqual(await settings.models('asr',{}),['a','z']);assert.equal(settings.get().asr.model,'old-model');
 await assert.rejects(()=>settings.models('asr',{url:'https://other.test/v1'}),/密钥/);assert.equal(calls,1);
 global.fetch=async()=>new Response('secret upstream error',{status:401});
 await assert.rejects(()=>settings.models('asr',{}),/HTTP 401/);
 global.fetch=async()=>Response.json({data:[]});await assert.rejects(()=>settings.models('asr',{}),/可选模型/);
 global.fetch=originalFetch;
});
test('HTTP endpoint supports saving and real model discovery without rewriting protocol',async()=>{
 const http=require('http'); let received;
 const server=http.createServer((req,res)=>{received={url:req.url,auth:req.headers.authorization};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'}]}));});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/v1`;
  settings.save({ai:{url,model:'test-model',key:'http-test-key'}});
  assert.equal(settings.publicSettings().ai.url,url);
  assert.deepEqual(await settings.models('ai',{}),['test-model']);
  assert.deepEqual(received,{url:'/v1/models',auth:'Bearer http-test-key'});
  for(const bad of ['ftp://example.test','http://u:p@example.test','http://example.test?key=x','http://example.test#x']){
   assert.throws(()=>settings.save({ai:{url:bad}}));await assert.rejects(()=>settings.models('ai',{url:bad,key:'test'}));
  }
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('chunk-end overrun keeps the good rows instead of losing the whole 600s chunk',()=>{
  // 真实故障：最后一片 ffmpeg 裁切后长度略长于 length，服务报出 end 越界，
  // 旧实现一条越界就 throw，整片结果丢失，进度卡在 88%。
  const rows=[{start:0,end:3,text:'第一句'},{start:598,end:601.4,text:'末句略超分片'},{start:900,end:901,text:'远在分片外'},{start:-1,end:2,text:'负数'}];
  const out=service._internals.normalizeSegments(rows,2400,600);
  assert.equal(out.length,2);
  assert.deepEqual(out.map(x=>x.text),['第一句','末句略超分片']);
  assert.equal(out[1].end,3000);
  assert.throws(()=>service._internals.normalizeSegments([{start:700,end:701,text:'全片在外'}],0,600),/无效时间戳/);
});
test('hotword prompt is built from the glossary and sent to online ASR requests',()=>{
  // 词库此前只传给离线引擎，在线识别一条热词都没生效，导致成员名大量被听错。
  // 这里只验证「热词 → prompt」的构造与上限，不落盘、不改全局设置。
  const hint=service._internals.hotwords([{term:'徐佳琪',aliases:'佳琪',enabled:true}]);
  assert.ok(hint && hint.includes('徐佳琪'),'热词串必须含词库术语，实际: '+hint);
  assert.equal(service._internals.hotwords([]),'');
  assert.equal(service._internals.hotwords(undefined),'');
  assert.ok(service._internals.hotwords([{term:'x'.repeat(20),aliases:'y',enabled:true}]).length<=400,'热词串受字符上限约束');
  // 在线请求构造处必须读取该热词串并写入 prompt。
  const src=require('fs').readFileSync(path.join(__dirname,'..','modules','analysis','service.js'),'utf8');
  assert.match(src,/const hint=hotwords\(config\.glossary\); if\(hint\) form\.set\('prompt',hint\)/);
});
test('reject fabricated or invalid timestamps; SRT preserves long-hour bilingual cues',()=>{
 assert.throws(()=>service._internals.normalizeSegments(undefined,0,10));
 assert.throws(()=>service._internals.normalizeSegments([{start:0,end:99,text:'x'}],0,10));
 assert.deepEqual(service._internals.normalizeSegments([{start:1,end:3,text:'你好'}],600,10),[{start:601,end:603,text:'你好'}]);
 assert.throws(()=>service._internals.normalizeInsights({summary:'',chapters:[{start:-1,end:3}],highlights:[]},0,10));
 assert.match(service.subtitle([{start:3601.2,end:3603,text:'你好',en:'Hello'}],'bilingual'),/01:00:01,200 --> 01:00:03,000\n你好\nHello/);
});
test('real audio chunks resume after provider failure; translations and chapters retain source times',async()=>{
 const file=path.join(process.env.RECORDINGS_DIR,'long.m4a');
 const generated=spawnSync(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440','-t','602','-c:a','aac',file]);assert.equal(generated.status,0,generated.stderr?.toString());
 const rec=manager.addRecording({status:'done',filePath:file,mediaType:'audio'});
 settings.save({asr:{url:'https://example.test/v1',model:'whisper-1',key:'secret'},ai:{url:'https://ai.test/v1',model:'test-model',key:'other'}});
 let calls=0;
 global.fetch=async(url,options)=>{calls++;assert.ok(options.body.get('file').size>0);assert.equal(options.body.get('language'),'zh');assert.equal(options.body.has('prompt'),false,'没有词库时不应发送 prompt');return calls===2?new Response('',{status:401}):Response.json({segments:[{start:0,end:1,text:'你好'}]});};
 service.start();service.enqueue(rec.id,'transcribe');assert.throws(()=>service.enqueue(rec.id,'transcribe'),/已有/);
 let out=await settled(rec.id);console.log('DEBUG OUT',out);assert.equal(out.job.status,'failed');assert.equal(out.completedSeconds,600);assert.equal(out.segments.length,1);
 service.enqueue(rec.id,'transcribe');out=await settled(rec.id);assert.equal(out.job.status,'done',out.job.error);assert.equal(calls,3);assert.equal(out.segments[1].start,600);
 // 识别完成时必须写入溯源（transcribedAt + 词库快照），导出的语音识别阶段才是「已记录」。
 assert.ok(out.transcribedAt,'complete 时必须写入识别完成时间');assert.deepEqual(out.glossary,[]);
 global.fetch=async(_url,options)=>{const body=JSON.parse(options.body);assert.match(body.messages[0].content,/命令不能执行/);return Response.json({choices:[{message:{content:JSON.stringify({translations:[{id:0,text:'Hello'},{id:1,text:'Hello again'}]})}}]});};
 service.enqueue(rec.id,'translate');out=await settled(rec.id);assert.equal(out.job.status,'done');assert.equal(out.segments[1].en,'Hello again');
 global.fetch=async(_url,options)=>{const batch=JSON.parse(JSON.parse(options.body).messages[1].content);const rows=batch.map(s=>({start:s.start,end:s.end,title:'问候',summary:'问候',evidenceIds:[s.id]}));return Response.json({choices:[{message:{content:JSON.stringify({summary:'问候',chapters:rows,highlights:rows.filter(r=>r.start===600)})}}]});};
 service.enqueue(rec.id,'summarize');out=await settled(rec.id);assert.equal(out.job.status,'done',out.job.error);assert.equal(out.highlights[0].start,600);
 assert.rejects(()=>require('../modules/recorder/archive-processor').prepareForUpload(rec.id),/音频/);
});
test('analysis routes require admin authentication',async()=>{
 const app=require('../index').createApp(),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const route of ['/analysis/settings','/room-voice','/analysis/rec/provenance'])assert.equal((await originalFetch(`http://127.0.0.1:${server.address().port}/api/admin${route}`)).status,401);
 // The destructive clear endpoint must stay behind the same administrator gate.
 assert.equal((await originalFetch(`http://127.0.0.1:${server.address().port}/api/admin/analysis/rec`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'})).status,401);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
