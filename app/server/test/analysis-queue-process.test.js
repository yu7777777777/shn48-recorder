'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const moduleRoot=path.resolve(__dirname,'../modules');
// All provider calls are mock fetch; each worker has a temporary DATA_DIR.
async function childMain(){
 const fs=require('node:fs'),path=require('node:path'),root=process.env.DATA_DIR,modules=process.env.MODULE_ROOT,file=path.join(root,'fixture.mp4');fs.writeFileSync(file,'offline');
 for(const [name,exports] of [['recorder/manager',{getRecording:id=>({id,status:'done',filePath:file})}],['recorder/archive-processor',{_internals:{resolveSource:()=>file}}],['recorder/replay-recovery',{busy:()=>false}]]){const id=require.resolve(path.join(modules,name));require.cache[id]={id,filename:id,loaded:true,exports};}
 const settings=require(path.join(modules,'analysis/settings')),service=require(path.join(modules,'analysis/service'));let calls=0;
 function output(options){const body=JSON.parse(JSON.parse(options.body).messages[1].content);if(Array.isArray(body)&&body[0]?.id!==undefined&&body[0]?.start!==undefined)return Response.json({choices:[{message:{content:JSON.stringify({summary:'valid',chapters:body.map(s=>({start:s.start,end:s.end,title:'chapter',summary:'evidence',evidenceIds:[s.id]})),highlights:[]})}}]});return Response.json({choices:[{message:{content:JSON.stringify({translations:[{id:0,text:'translated'}]})}}]});}
 if(process.env.MODE==='initial'){
  settings.save({ai:{url:'https://mock.invalid/v1',model:'m',key:'offline-fixture'},queue:{autoRetry:false,maxRetries:3,resumeInterrupted:process.env.RESUME==='1'}});
  settings.write('analysis_summary',{segments:[{start:0,end:10,text:'first'},{start:600,end:610,text:'second'}],summary:'previous',chapters:[],highlights:[]});settings.write('analysis_queued',{segments:[{start:0,end:1,text:'pending'}],chapters:[],highlights:[]});
  global.fetch=async(_url,options)=>{calls++;if(calls===2){process.send({event:'checkpoint',calls});return new Promise(()=>{});}return output(options);};
  service.enqueue('summary','summarize');service.enqueue('queued','translate');setInterval(()=>{},1000);
 }else if(process.env.MODE==='intruder'){
  const before=fs.readFileSync(path.join(root,'analysis_jobs.json'),'utf8'),results=[];
  for(const operation of [()=>service.enqueue('another','translate'),()=>service.cancel('summary'),()=>service.editSegment('queued',0,'bad'),()=>service.restoreOriginal('queued')]){try{operation();results.push(false);}catch(e){results.push(e.statusCode===409);}}
  try{await service.importSrt('queued',{text:'bad'});results.push(false);}catch(e){results.push(e.statusCode===409);}
  const status=await service.start();process.send({event:'intruder',results,unchanged:before===fs.readFileSync(path.join(root,'analysis_jobs.json'),'utf8'),visible:service.result('summary').job.status,status});process.disconnect();
 }else{
  global.fetch=async(_url,options)=>{calls++;return output(options);};await service.start();await service.stop();process.send({event:'recovered',calls,summary:service.result('summary'),queued:service.result('queued')});process.disconnect();
 }
}
function launch(directory,mode,resume){return spawn(process.execPath,['-e','('+childMain.toString()+')().catch(e=>{console.error(e);process.exitCode=1;process.disconnect?.();})'],{env:{...process.env,DATA_DIR:directory,MODULE_ROOT:moduleRoot,MODE:mode,RESUME:resume?'1':'0'},stdio:['ignore','inherit','inherit','ipc']});}
function message(child){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('worker timeout'));},10000);child.once('message',value=>{clearTimeout(timeout);resolve(value);});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);reject(Error('worker exited before message '+code));});});}
async function kill(child){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
for(const resume of [false,true])test('real process restart preserves queued and '+(resume?'reuses completed summary checkpoint with opt-in':'fails interrupted safely by default'),async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-process-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const owner=launch(root,'initial',resume);t.after(()=>{if(owner.exitCode===null)owner.kill('SIGKILL');});assert.equal((await message(owner)).event,'checkpoint');
 const checkpoint=JSON.parse(fs.readFileSync(path.join(root,'analysis_summary_summary_checkpoint.json'),'utf8'));assert.equal(checkpoint.completed.length,1);
 const intruder=launch(root,'intruder',resume),denied=await message(intruder);assert.deepEqual(denied.results,[true,true,true,true,true]);assert.equal(denied.unchanged,true);assert.equal(denied.visible,'running');assert.equal(denied.status.state,'unavailable');assert.equal(denied.status.owned,false);assert.equal(denied.status.localOnly,true);assert.deepEqual(Object.keys(denied.status).sort(),['error','health','localOnly','owned','queued','running','state']);assert.equal(denied.status.health.localOnly,true,'the health block is counts only');
 await kill(owner);const restarted=launch(root,'recover',resume),output=await message(restarted);assert.equal(output.event,'recovered');assert.equal(output.queued.job.status,'done');assert.equal(output.summary.job.status,resume?'done':'failed');assert.equal(output.calls,resume?2:1);assert.equal(output.summary.job.retryCount,resume?1:0);if(!resume)assert.equal(output.summary.summary,'previous');else assert.equal(output.summary.summaryCoverage.complete,true);
});
