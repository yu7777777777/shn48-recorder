const fs=require('fs'),assert=require('assert/strict'),media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 const rows=JSON.parse(fs.readFileSync('/app/data/recordings.json'));
 const expected={rec_1793455319510_jc46a:'79fb7055c4a5e2ca9ed9235e9ed9e7dab3dc65fdd74988a1b913386358ae622f',rec_1793453189443_mbo87:'8fd971e6fc08848ffd7e54b4d5f5798259636c426c8397bd05a90db0f48e8344'};
 const result=[];
 for(const [id,hash] of Object.entries(expected)){
  const rec=rows.find(r=>r.id===id);assert.ok(rec);assert.equal(await media.digest(rec.filePath),hash);
  result.push({id,filePath:rec.filePath,sha256:hash,durationSeconds:rec.durationSeconds,draftId:rec.draftId,uploadStatus:rec.uploadStatus,archiveVersion:rec.archiveVersion});
 }
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exit(1)});
