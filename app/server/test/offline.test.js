const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'offline-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const service=require('../modules/analysis/service'),settings=require('../modules/analysis/settings'),manager=require('../modules/recorder/manager'),offline=require('../modules/analysis/offline');
const originalTranscribe=offline.transcribe,originalFetch=global.fetch;
test.after(()=>{service.stop();offline.transcribe=originalTranscribe;global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
async function waitFor(fn){const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}}
test('offline queue needs installed model, waits during recording and cancels without API calls',async()=>{
 const file=path.join(process.env.RECORDINGS_DIR,'test.wav');fs.copyFileSync(path.join(__dirname,'../assets/asr-test.wav'),file);
 const rec=manager.addRecording({status:'done',filePath:file});settings.save({offline:{enabled:true,model:'tiny'}});
 assert.throws(()=>settings.save({offline:{enabled:true,model:'../other'}}));assert.throws(()=>service.enqueue(rec.id,'transcribe'),/安装/);
 const model=path.join(process.env.DATA_DIR,'asr-models','tiny');fs.mkdirSync(model,{recursive:true});fs.writeFileSync(path.join(model,'.ready'),'test');
 const live=manager.addRecording({status:'recording',filePath:file});
 global.fetch=async()=>{throw new Error('offline must never call API');};let calls=0;offline.transcribe=async()=>{calls++;return {segments:[{start:0,end:1,text:'你好'}]};};
 service.start();service.enqueue(rec.id,'transcribe');await waitFor(()=>service.result(rec.id).job.phase?.includes('等待'));assert.equal(calls,0);service.cancel(rec.id);await waitFor(()=>!service.busy(rec.id));assert.equal(service.result(rec.id).job.status,'failed');assert.equal(calls,0);
 live.status='done';service.enqueue(rec.id,'transcribe');await waitFor(()=>!service.busy(rec.id));const result=service.result(rec.id);assert.equal(result.job.status,'done',result.job.error);assert.equal(result.source,'offline');assert.equal(calls,1);assert.equal(result.model,'tiny');
 const aborted=new AbortController();aborted.abort();await assert.rejects(()=>originalTranscribe(file,'tiny','',aborted.signal),/取消/);assert.equal(offline.status().active,false);
});
test('the offline catalogue offers three pinned tiers and rejects anything else before spawning',async()=>{
 const models=offline.status().models.map(m=>m.id);
 assert.deepEqual(models,['tiny','base','small']);
 settings.save({offline:{enabled:true,model:'small'}});
 assert.equal(settings.get().offline.model,'small');
 assert.throws(()=>settings.save({offline:{enabled:true,model:'large-v3'}}),/有效离线模型/);
 assert.equal(settings.get().offline.model,'small','a rejected save must not change the stored model');
 await assert.rejects(()=>originalTranscribe('nope.wav','large-v3','',new AbortController().signal),/离线模型无效/);
 // 'small' is accepted by validation and only fails because it is not installed here.
 await assert.rejects(()=>originalTranscribe('nope.wav','small','',new AbortController().signal),/安装/);
 settings.save({offline:{enabled:true,model:'base'}});
});
