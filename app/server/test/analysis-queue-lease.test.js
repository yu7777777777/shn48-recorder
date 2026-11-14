'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const createLease=require('../modules/analysis/queue-lease');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-lease-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('live owner is never stolen, including expired heartbeat; release permits next owner',t=>{
 const directory=temporary(t),a=createLease({directory}),b=createLease({directory});a.acquire();t.after(()=>a.release());const original=JSON.parse(fs.readFileSync(a.ownerPath));fs.writeFileSync(a.ownerPath,JSON.stringify({...original,expiresAt:0}));assert.throws(()=>b.acquire(),/活跃/);assert.equal(JSON.parse(fs.readFileSync(a.ownerPath)).token,original.token);a.release();b.acquire();b.release();
});
test('different host and malformed owners fail closed, not deleted',t=>{
 const directory=temporary(t),a=createLease({directory});a.acquire();const original=JSON.parse(fs.readFileSync(a.ownerPath));fs.writeFileSync(a.ownerPath,JSON.stringify({...original,host:'some-other-host'}));assert.throws(()=>createLease({directory}).acquire(),/主机/);assert.ok(fs.existsSync(a.ownerPath));fs.writeFileSync(a.ownerPath,'{}');assert.throws(()=>createLease({directory}).acquire());fs.writeFileSync(a.ownerPath,JSON.stringify(original));a.release();
});
test('same hostname but different PID namespace remains unavailable and untouched',t=>{
 const directory=temporary(t),a=createLease({directory});a.acquire();const owner=JSON.parse(fs.readFileSync(a.ownerPath));fs.writeFileSync(a.ownerPath,JSON.stringify({...owner,namespace:'different-container-pidns'}));assert.throws(()=>createLease({directory}).acquire(),/命名空间/);assert.equal(JSON.parse(fs.readFileSync(a.ownerPath)).namespace,'different-container-pidns');fs.writeFileSync(a.ownerPath,JSON.stringify(owner));a.release();
});
test('initial owner write failure removes only the directory created by this acquire',t=>{
 const directory=temporary(t),store=require('../lib/store'),original=store.atomicWrite,a=createLease({directory});try{store.atomicWrite=()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});};assert.throws(()=>a.acquire(),/disk full/);assert.equal(fs.existsSync(path.dirname(a.ownerPath)),false);}finally{store.atomicWrite=original;}a.acquire();a.release();
});
test('loss of token aborts once and old owner never removes replacement',t=>{
 const directory=temporary(t);let lost=0,heartbeat;const a=createLease({directory,onLost:()=>lost++,setTimer:fn=>{heartbeat=fn;return {unref(){}};},clearTimer:()=>{}});a.acquire();const owner=JSON.parse(fs.readFileSync(a.ownerPath));fs.writeFileSync(a.ownerPath,JSON.stringify({...owner,token:'replacement'}));heartbeat();assert.equal(lost,1);assert.throws(()=>a.assertOwned());assert.equal(lost,1);a.release();assert.equal(JSON.parse(fs.readFileSync(a.ownerPath)).token,'replacement');
});
test('real second process rejects live owner then recovers after killed owner',async t=>{
 const directory=temporary(t),modulePath=require.resolve('../modules/analysis/queue-lease');
 const code="const lease=require(process.env.LEASE_MODULE)({directory:process.env.DATA_DIR});lease.acquire();process.send({ready:true});setInterval(()=>{},1000);";
 const child=spawn(process.execPath,['-e',code],{env:{...process.env,DATA_DIR:directory,LEASE_MODULE:modulePath},stdio:['ignore','inherit','inherit','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('owner exited '+c)));});
 const next=createLease({directory});assert.throws(()=>next.acquire(),/活跃/);
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;next.acquire();assert.equal(JSON.parse(fs.readFileSync(next.ownerPath)).pid,process.pid);next.release();
});
