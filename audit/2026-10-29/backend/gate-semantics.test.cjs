'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shn48-gate-semantics-'));
process.env.DATA_DIR=root;process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const app=path.resolve(__dirname,'../../../app/server');
const auto=require(path.join(app,'modules/pocket48/auto-recorder'));
const retention=require(path.join(app,'modules/recorder/retention'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('no candidates clears the block and logs cleared while disk remains below requirement; no recording is created',async()=>{
 let lives=[{liveId:'audit-live',member:{id:'audit-member'}}],starts=0;const messages=[];
 const original=retention.reclaimNow,log=console.log;retention.reclaimNow=async()=>({free:0,files:0,freed:0});console.log=(...args)=>messages.push(args.join(' '));
 const service=auto.createAutoRecorder({live:{listLives:async()=>({list:lives})},recorder:{_internals:{recordingsDir:()=>process.env.RECORDINGS_DIR},listActive:()=>[],start:async()=>{starts++;return {recordingId:'unexpected'};},onFinalized:()=>{},stop:async()=>{}},uploads:{setRecordingActive(){}},manager:{getRecordings:()=>[]},statfs:()=>({bavail:0,bsize:1})});
 try{service.setConfig({enabled:true,members:[{memberId:'audit-member'}],minFreeGiB:2});await service.poll();assert.equal(service.getStatus().blocked.reason,'disk_space');assert.equal(starts,0);lives=[];await service.poll();assert.equal(service.getStatus().blocked,undefined);assert.equal(service.getStatus().recordingStatus.hasSpace,false);assert.equal(starts,0);assert.ok(messages.some(v=>v.includes('start gate cleared')));console.error('AUDIT_SEMANTICS: no candidates -> blocked cleared, hasSpace=false, starts=0');}finally{service.stop();retention.reclaimNow=original;console.log=log;}
});
