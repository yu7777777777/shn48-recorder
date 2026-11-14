"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'48tools-voice-test-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const file=path.join(root,'fixture.m4a');
const generated=cp.spawnSync(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440','-t','20','-c:a','aac',file]);
const originalSpawn=cp.spawn;
// Use a real local FFmpeg input while mocking only the upstream stream lookup.
cp.spawn=(bin,args,opts)=>{if(args.includes('https://stream.example/audio')){args=[...args];args[args.indexOf('https://stream.example/audio')]=file;args.splice(args.indexOf('-i'),0,'-re');}return originalSpawn(bin,args,opts);};
const voice=require('../modules/pocket48/room-voice');cp.spawn=originalSpawn;
const api=require('../modules/pocket48/api'),manager=require('../modules/recorder/manager');
api.getRoomVoice=async()=>({status:200,data:{status:200,content:{streamUrl:'https://stream.example/audio'}}});
api.getRoomMessages=async()=>({status:200,data:{status:200,content:{messages:[{msgId:'1',msgTime:Date.now(),content:'test'}]}}});
test.after(async()=>{await voice.stopAll();fs.rmSync(root,{recursive:true,force:true});});
test('reject non-media protocols',()=>{assert.throws(()=>voice._internals.validStream('file:///etc/passwd'));assert.throws(()=>voice._internals.validStream('http://127.0.0.1/a'));});
test('manual stop archives real audio immediately, persists messages and pauses watch',async()=>{
 assert.equal(generated.status,0,generated.stderr?.toString());voice.start();
 voice.saveWatch({roomId:'1',ownerId:'2',ownerName:'测试',enabled:true});
 const rec=await voice.record({roomId:'1',ownerId:'2',ownerName:'测试'});
 await new Promise(r=>setTimeout(r,2500));await voice.stop('1');
 const saved=manager.getRecording(rec.id);assert.equal(saved.status,'done',saved.error);assert.ok(saved.duration>0);assert.equal(saved.manualStop,true);assert.equal(voice.status().watches[0].enabled,false);assert.equal(voice.messages(rec.id).length,1);assert.equal(voice.status().active.length,0);
});
