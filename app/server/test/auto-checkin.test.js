const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-test-'));
const api=require('../modules/pocket48/api');
const scheduler=require('../modules/pocket48/auto-checkin');
test('random window, skip signed day, persist and pause on account changes',async()=>{
 const original={now:Date.now,token:api.getToken,info:api.getCheckinInfo,sign:api.doCheckin};let now=Date.parse('2026-09-14T08:00:00+08:00'),writes=0,checked=false;
 Date.now=()=>now;api.getToken=()=>({userId:'1',token:'test'});api.getCheckinInfo=async()=>({status:200,data:{status:200,content:{hasCheck:checked}}});api.doCheckin=async()=>{writes++;return {status:200,data:{status:200,content:{}}};};
 try{
 assert.throws(()=>scheduler.configure({enabled:true,start:'11:00',end:'09:00'}));
 const s=scheduler.configure({enabled:true,start:'09:00',end:'11:00'});assert.ok(s.nextAt>=Date.parse('2026-09-14T09:00:00+08:00')&&s.nextAt<Date.parse('2026-09-14T11:00:00+08:00'));
 now=s.nextAt;await scheduler.tick();await scheduler.tick();assert.equal(writes,1);
 checked=true;now=scheduler.status().nextAt;await scheduler.tick();assert.equal(writes,1);assert.match(scheduler.status().lastResult,/跳过/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR,'auto-checkin.json'))).lastDate,'2026-09-15');
 now=scheduler.status().nextAt;api.getToken=()=>({userId:'2',token:'other'});await scheduler.tick();assert.equal(scheduler.status().enabled,false);assert.equal(writes,1);
 }finally{Date.now=original.now;api.getToken=original.token;api.getCheckinInfo=original.info;api.doCheckin=original.sign;scheduler.stop();}
});
test('re-enabling after a failed attempt retries the same day instead of skipping it',async()=>{
 // Run in its own process: the scheduler keeps a module-level singleton, so a
 // sibling test's in-memory state would leak into this one.
 const {execFileSync}=require('child_process');
 const script=`
 const fs=require('fs'),os=require('os'),path=require('path');
 process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-retry-'));
 const api=require('./modules/pocket48/api');
 const scheduler=require('./modules/pocket48/auto-checkin');
 let now=Date.parse('2026-09-20T08:00:00+08:00'),writes=0;
 Date.now=()=>now;api.getToken=()=>({userId:'1',token:'test'});
 api.getCheckinInfo=async()=>({status:200,data:{status:401004,success:false,message:'busy'}});
 api.doCheckin=async()=>{writes++;return {status:200,data:{status:200,content:{}}};};
 (async()=>{
   const s=scheduler.configure({enabled:true,start:'09:00',end:'11:00'});
   now=s.nextAt;await scheduler.tick();
   const failed=scheduler.status();
   const persisted=JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR,'auto-checkin.json')));
   if(failed.enabled!==false)throw new Error('失败后应暂停');
   if(!/已暂停/.test(failed.lastResult))throw new Error('应显示暂停原因');
   if(persisted.lastDate!=='')throw new Error('失败不应占用当天，实际 '+persisted.lastDate);

   api.getCheckinInfo=async()=>({status:200,data:{status:200,content:{hasCheck:false}}});
   const again=scheduler.configure({enabled:true,start:'09:00',end:'11:00'});
   if(again.lastResult!=='')throw new Error('重新启用后不应保留旧暂停文案，实际 '+again.lastResult);
   now=again.nextAt;await scheduler.tick();
   if(writes!==1)throw new Error('当天重新启用后应真正签到，实际写入 '+writes);
   if(!/成功/.test(scheduler.status().lastResult))throw new Error('应报告签到成功');
   scheduler.stop();
   console.log('OK');
 })().catch(e=>{console.error(e.message);process.exit(1);});
 `;
 assert.equal(execFileSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),encoding:'utf8'}).trim(),'OK');
});
