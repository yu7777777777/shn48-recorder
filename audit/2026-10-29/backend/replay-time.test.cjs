'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shn48-replay-time-'));process.env.DATA_DIR=root;
const app=path.resolve(__dirname,'../../../app/server');const replay=require(path.join(app,'modules/pocket48/replay'));const watch=require(path.join(app,'modules/pocket48/replay-watch'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('audit reproduces watch omission for normalized numeric timestamps against an ISO control',()=>{
 const timestamp=1793229596318,since=timestamp-1000,opts={memberId:'407126',since};
 const rows=[String(timestamp),timestamp,new Date(timestamp).toISOString()].map(startTime=>{const normalized=replay.normalizeReplay({liveId:'990081',startTime,userInfo:{userId:'407126',nickName:'audit'}});return {input:startTime,normalizedStartedAt:normalized.startedAt,dateParseFinite:Number.isFinite(Date.parse(normalized.startedAt)),selected:watch.select([normalized],opts)};});
 assert.deepEqual(rows[0].selected,[]);assert.deepEqual(rows[1].selected,[]);assert.deepEqual(rows[2].selected,['990081']);console.log('AUDIT_TIMESTAMP_DEFECT '+JSON.stringify({since,expectedEach:['990081'],rows}));
});
