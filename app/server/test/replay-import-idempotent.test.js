'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'replay-idem-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');
fs.mkdirSync(process.env.DATA_DIR,{recursive:true});fs.mkdirSync(process.env.RECORDINGS_DIR,{recursive:true});
const imports=require('../modules/recorder/replay-import'),manager=require('../modules/recorder/manager'),recorder=require('../modules/pocket48/recorder');
const ID='481234567890123456';
const originals={recordings:manager.getRecordings,active:recorder.listActive};
function restore(){manager.getRecordings=originals.recordings;recorder.listActive=originals.active;}
test.after(()=>{restore();fs.rmSync(root,{recursive:true,force:true});});

test('the same live id submitted twice yields one job, not two downloads',()=>{
  restore();manager.getRecordings=()=>[];recorder.listActive=()=>[];
  const first=imports.enqueue({liveId:ID});
  const second=imports.enqueue({liveId:ID});
  assert.equal(second.id,first.id,'the second submission returns the running job');
  assert.equal(imports.activeLiveIds().filter(id=>String(id)===ID).length,1);
});

test('a manual retry can still ask for the old throwing behaviour',()=>{
  restore();manager.getRecordings=()=>[];recorder.listActive=()=>[];
  const first=imports.enqueue({liveId:ID});
  assert.ok(first.id);
  assert.throws(()=>imports.enqueue({liveId:ID,idempotent:false}),err=>err.code==='IMPORT_ACTIVE');
});

test('an archived live id is refused even when the submission is idempotent',()=>{
  restore();manager.getRecordings=()=>[{id:'rec',liveId:'482000000000000009',status:'done',filePath:__filename}];recorder.listActive=()=>[];
  assert.throws(()=>imports.enqueue({liveId:'482000000000000009'}),err=>err.code==='ARCHIVE_EXISTS');
});
