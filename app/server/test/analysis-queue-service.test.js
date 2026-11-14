'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-queue-service-'));process.env.DATA_DIR=root;
const file=path.join(root,'fixture.mp4');fs.writeFileSync(file,'offline');
for(const [name,exports] of [['../modules/recorder/manager',{getRecording:id=>({id,status:'done',filePath:file})}],['../modules/recorder/archive-processor',{_internals:{resolveSource:()=>file}}],['../modules/recorder/replay-recovery',{busy:()=>false}]]){const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
const settings=require('../modules/analysis/settings'),store=require('../lib/store'),queue=require('../modules/analysis/queue');
const originalFetch=global.fetch,originalWrite=settings.write;
const servicePath=require.resolve('../modules/analysis/service');let service=require(servicePath);
let now=1000000,sequence=0,timers=new Map();
const clock={now:()=>now,setTimer:(fn,delay)=>{const timer={id:++sequence,unref(){}};timers.set(timer,{fn,at:now+delay});return timer;},clearTimer:t=>timers.delete(t)};
function seed(id){settings.write('analysis_'+id,{segments:[{start:0,end:1,text:'source'}],chapters:[],highlights:[]});}
function configure(queueConfig={}){settings.save({ai:{url:'https://mock.test/v1',model:'m',key:'fixture'},queue:{autoRetry:false,maxRetries:3,resumeInterrupted:false,...queueConfig}});}
function success(){return Response.json({choices:[{message:{content:JSON.stringify({translations:[{id:0,text:'translated'}]})}}]});}
async function idle(){await new Promise(resolve=>setImmediate(resolve));await service._internals.idle();}
async function advance(ms){now+=ms;for(const [timer,value] of [...timers])if(value.at<=now){timers.delete(timer);value.fn();}await idle();}
async function fresh(jobs=[]){await service.stop();delete require.cache[servicePath];settings.write('analysis_jobs',jobs);service=require(servicePath);service._internals.setClock(clock);}
test.after(async()=>{settings.write=originalWrite;await service.stop();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
test('require is read only; queued restart executes while interrupted defaults failed',async()=>{
 configure();seed('queued');seed('running');await fresh([{id:'q',recordingId:'queued',kind:'translate',status:'queued'},{id:'r',recordingId:'running',kind:'translate',status:'running'}]);
 assert.equal(fs.existsSync(path.join(root,'.analysis-worker')),false);assert.equal(store.load('analysis_jobs',[])[1].status,'running');let calls=0;global.fetch=async()=>{calls++;return success();};await service.start();assert.equal(calls,1);assert.equal(service.result('queued').job.status,'done');assert.equal(service.result('running').job.status,'failed');assert.equal(service.result('queued').job.attempts,1);
});
test('persist retains earliest waiting retry beyond 300 newer terminal jobs',async()=>{
 configure({autoRetry:true});seed('old-pending');const pending={id:'pending',recordingId:'old-pending',kind:'translate',status:'queued',retryMode:'automatic',retryCount:1,attempts:1,nextAttemptAt:new Date(now+86400000).toISOString(),configFingerprint:queue.fingerprint(settings.get(),'translate')};const history=Array.from({length:305},(_,id)=>({id:'terminal-'+id,recordingId:'history-'+id,kind:'translate',status:'done'}));await fresh([pending,...history]);let calls=0;global.fetch=async()=>{calls++;return success();};await service.start();const saved=store.load('analysis_jobs',[]);assert.equal(saved.length,301);assert.equal(saved[0].id,'pending');assert.equal(saved[1].id,'terminal-5');assert.equal(saved.at(-1).id,'terminal-304');assert.equal(service.busy('old-pending'),true);assert.equal(calls,0);
});
test('enqueue automatically pumps; retry persists counters, obeys due time and favors new work',async()=>{
 await fresh();configure({autoRetry:true});seed('retry');seed('fresh');let calls=[];global.fetch=async()=>{calls.push('retry');return new Response('',{status:503});};service.enqueue('retry','translate');await idle();let j=service.result('retry').job;assert.equal(j.status,'queued');assert.equal(j.retryCount,1);assert.equal(j.attempts,1);assert.equal(Date.parse(j.nextAttemptAt),now+300000);
 now+=300000;global.fetch=async()=>{calls.push('success');return success();};service.enqueue('fresh','translate');await idle();assert.equal(service.result('fresh').job.status,'done');assert.equal(service.result('retry').job.status,'done');assert.equal(service.result('retry').job.attempts,2);assert.equal(calls.length,3);
});
test('cancelling delayed retry persists terminal state and prevents later model calls',async()=>{
 await fresh();configure({autoRetry:true});seed('cancel');let calls=0;global.fetch=async()=>{calls++;return new Response('',{status:429});};service.enqueue('cancel','translate');await idle();assert.equal(timers.size,1);service.cancel('cancel');assert.equal(service.result('cancel').job.status,'failed');assert.equal(timers.size,0);await advance(86400000);assert.equal(calls,1);
});
test('closing autoRetry or changing endpoint/model invalidates old delayed retry',async()=>{
 for(const mutation of [{queue:{autoRetry:false}},{ai:{url:'https://other.test/v1'}},{ai:{model:'other'}}]){
  await fresh();configure({autoRetry:true});seed('change');let calls=0;global.fetch=async()=>{calls++;return new Response('',{status:503});};service.enqueue('change','translate');await idle();settings.save(mutation);await advance(300000);assert.equal(calls,1);assert.equal(service.result('change').job.status,'failed');
 }
});
test('strict interrupted opt-in shares cumulative retry budget and survives re-restart',async()=>{
 configure({resumeInterrupted:true});seed('recover');const c=settings.get(),j={id:'recover',recordingId:'recover',kind:'translate',status:'running',attempts:2,retryCount:2,configFingerprint:queue.fingerprint(c,'translate')};await fresh([j]);global.fetch=async()=>success();await service.start();const recovered=service.result('recover').job;assert.equal(recovered.status,'done');assert.equal(recovered.retryCount,3);assert.equal(recovered.attempts,3);assert.equal(recovered.recovery.resumed,true);
 await fresh([{...j,retryCount:3}]);let calls=0;global.fetch=async()=>{calls++;return success();};await service.start();assert.equal(service.result('recover').job.status,'failed');assert.equal(calls,0);
});
test('queue write failure rolls back enqueue and releases running flag without unhandled rejection',async()=>{
 await fresh();configure({autoRetry:true});seed('disk');await service.start();const before=store.load('analysis_jobs',[]);settings.write=(name,data)=>{if(name==='analysis_jobs')throw Object.assign(Error('disk full'),{code:'ENOSPC'});return originalWrite(name,data);};assert.throws(()=>service.enqueue('disk','translate'),/disk/);assert.equal(service.busy('disk'),false);assert.deepEqual(store.load('analysis_jobs',[]),before);settings.write=originalWrite;
 let calls=0;global.fetch=async()=>{calls++;settings.write=(name,data)=>{if(name==='analysis_jobs')throw Object.assign(Error('disk full'),{code:'ENOSPC'});return originalWrite(name,data);};return new Response('',{status:503});};service.enqueue('disk','translate');await idle();assert.equal(calls,1);assert.equal(service.busy('disk'),false);assert.equal(service.queueStatus().state,'unavailable');assert.ok(service.queueStatus().error);settings.write=originalWrite;assert.equal((await service.start()).state,'idle');assert.equal(service.result('disk').job.status,'failed');assert.equal(service.queueStatus().error,null);await service.stop();assert.equal(fs.existsSync(path.join(root,'.analysis-worker')),false);
});
test('enqueue can recover startup-only failure, while explicit stop requires start',async()=>{
 await fresh();configure();seed('startup');fs.mkdirSync(path.join(root,'.analysis-worker-reclaim'));assert.equal((await service.start()).state,'unavailable');fs.rmdirSync(path.join(root,'.analysis-worker-reclaim'));global.fetch=async()=>success();service.enqueue('startup','translate');await idle();assert.equal(service.result('startup').job.status,'done');assert.equal(service.queueStatus().error,null);await service.stop();seed('manual');assert.throws(()=>service.enqueue('manual','translate'),/显式启动/);await service.start();service.enqueue('manual','translate');await idle();assert.equal(service.result('manual').job.status,'done');
});
test('invalid startup data is nonfatal, never overwritten, and successful start clears safe error',async()=>{
 await fresh();configure();fs.writeFileSync(store.filePath('analysis_jobs'),'{}');const status=await service.start();assert.equal(status.state,'unavailable');assert.equal(status.owned,false);assert.equal(status.localOnly,true);assert.equal(fs.readFileSync(store.filePath('analysis_jobs'),'utf8'),'{}');assert.equal(status.error.includes(root),false);settings.write('analysis_jobs',[]);const ready=await service.start();assert.equal(ready.state,'idle');assert.equal(ready.error,null);
});
test('stop waits for in-flight request, never retries or commits after abort, leaves ordinary queued intact',async()=>{
 await fresh();configure({autoRetry:true});seed('stop');seed('pending');let finish,started;const entered=new Promise(resolve=>started=resolve);global.fetch=async()=>{started();return new Promise(resolve=>finish=()=>resolve(success()));};service.enqueue('stop','translate');await entered;service.enqueue('pending','translate');const stopping=service.stop();assert.equal(fs.existsSync(path.join(root,'.analysis-worker')),true);finish();await stopping;assert.equal(service.result('stop').job.status,'failed');assert.equal(service.result('stop').job.retryCount,0);assert.equal(service.result('pending').job.status,'queued');assert.equal(store.load('analysis_stop',{}).segments[0].en,undefined);assert.equal(fs.existsSync(path.join(root,'.analysis-worker')),false);
});
