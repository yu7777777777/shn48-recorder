set -euo pipefail
REL=/opt/shn48/releases/1.32.2
grep -q '^# pass 73$' "$REL/server-tests.log"
docker run --rm -i --network none --memory=512m --cpus=1 --entrypoint node -v /opt/shn48/runtime/data/.replay-diagnostics-20261102:/app/data/.replay-diagnostics-20261102:rw shn48-shn48:1.32.2-r2 <<'NODE' | tee "$REL/real-replays-fast.log"
const fs=require('fs');
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 for(const liveId of ['1323430498988265472','1323043490600128512']){
  const directory='/app/data/.replay-diagnostics-20261102/'+liveId;
  console.log('START',liveId);
  const r=await media.download({liveId,directory,verify:false,getReplay(){throw Error('Offline source required')},request(){throw Error('Offline source required')}});
  const validation=JSON.parse(fs.readFileSync(directory+'/validation.json'));
  if(validation.error)throw Error('Validation error');
  console.log(JSON.stringify({liveId,durationSeconds:r.durationSeconds,manifestDuration:r.manifestDuration,sha256:r.sha256,segments:r.segments,verification:r.verification,periods:validation.periods.length,sourcePackets:validation.expectedPackets,resultPackets:validation.actualPackets}));
 }
})().catch(e=>{console.error(e.preset||e.message==='Offline source required'?e.message:'Candidate replay validation failed: '+(e.code||e.name));process.exitCode=1});
NODE
