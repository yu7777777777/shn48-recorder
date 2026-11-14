const fs=require('fs'),path=require('path'),assert=require('assert/strict'),media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 const baseline=JSON.parse(process.argv[2]),rows=JSON.parse(fs.readFileSync('/app/data/recordings.json')),audits=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));
 const expected={rec_1793455319510_jc46a:{sha256:'6e82bdd2dc2fd265605f1cef19f57c6a5f52bf0c3854356f6990e572a6f81aea',seconds:373.76,listed:589},rec_1793453189443_mbo87:{sha256:'8862457497dcdd30176829411ad91cd00e81eaa762f2ffce9799b4bc7c14797d',seconds:330.067,listed:574}};
 for(const before of baseline){
  const rec=rows.find(r=>r.id===before.id),audit=audits[before.id],want=expected[before.id];
  assert.equal(audit.status,'repaired_source_limited_published');assert.equal(rec.replayAudit.status,audit.status);assert.equal(audit.error,null);assert.equal(audit.nextAttemptAt,null);
  assert.equal(audit.listedOfficialSeconds,want.listed);assert.equal(audit.manualRepair,false);
  assert.equal(rec.durationSeconds,want.seconds);assert.notEqual(rec.filePath,before.filePath);assert.equal(rec.replayAudit.originalFile,before.filePath);assert.ok(rec.sourceFiles.includes(before.filePath));
  assert.equal(rec.draftId,before.draftId);assert.equal(rec.uploadStatus,before.uploadStatus);assert.equal(rec.archiveVersion,Math.max(1,Number(before.archiveVersion)||0)+1);
  assert.equal(await media.digest(before.filePath),before.sha256);assert.equal(await media.digest(rec.filePath),want.sha256);assert.equal(rec.fileSha256,want.sha256);
  const complete=JSON.parse(fs.readFileSync(path.join(path.dirname(rec.filePath),'complete.json')));assert.equal(complete.verification,'full');assert.equal(complete.sha256,want.sha256);
  const validation=JSON.parse(fs.readFileSync(path.join(path.dirname(rec.filePath),'validation.json')));assert.deepEqual(validation.expectedPackets,validation.actualPackets);
  if(before.id==='rec_1793455319510_jc46a'){assert.equal(validation.method,'separate_tracks');assert.deepEqual(validation.actualPackets,[{type:'video',packets:1817},{type:'audio',packets:14740}]);}
  console.log(JSON.stringify({id:before.id,status:audit.status,durationSeconds:rec.durationSeconds,listedOfficialSeconds:audit.listedOfficialSeconds,filePath:rec.filePath,sha256:want.sha256,verification:complete.verification,packets:validation.actualPackets,audioOnlySeconds:validation.audioOnlySeconds,originalPreserved:true,bilibiliUnchanged:true,archiveVersion:rec.archiveVersion,error:null,nextAttemptAt:null}));
 }
 const bundle=fs.readdirSync('/app/client/dist/assets').filter(n=>/^ReplayAudit-.*\.js$/.test(n));assert.equal(bundle.length,1);const js=fs.readFileSync('/app/client/dist/assets/'+bundle[0],'utf8');assert.ok(js.includes('已修复 · 官方源受限'));assert.ok(js.includes('修复可下载源'));
 console.log(JSON.stringify({replayAuditBundle:bundle[0],newLabels:true,counts:Object.values(audits).reduce((a,x)=>(a[x.status]=(a[x.status]||0)+1,a),{})}));
})().catch(e=>{console.error(e);process.exit(1)});
