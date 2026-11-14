set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path');
const media=require('/app/server/modules/recorder/replay-download');
const {execFileSync}=require('child_process');
(async()=>{
 for (const liveId of ['1323430498988265472','1323043490600128512']) {
  const directory='/app/recordings/.replay-diagnostics-20261102/'+liveId;
  console.log('START',liveId);
  try {const r=await media.download({liveId,directory,verify:false});console.log('ACCEPT',JSON.stringify({liveId,duration:r.durationSeconds,manifest:r.manifestDuration}));}
  catch(e){console.log('FAIL',liveId,e.preset?e.message:'internal');}
  const planFile=path.join(directory,'plan.json');
  if(fs.existsSync(planFile)){
   const p=JSON.parse(fs.readFileSync(planFile));
   console.log('PLAN',JSON.stringify({liveId,seconds:p.seconds,segments:p.segments,resources:p.resources.length,completed:Object.keys(p.completed).length,discontinuities:(p.local.match(/#EXT-X-DISCONTINUITY\b/g)||[]).length,durations:p.local.split('\n').filter(x=>x.startsWith('#EXTINF:')).slice(0,10)}));
  }
  const mp4=path.join(directory,'replay.processing.mp4');
  if(fs.existsSync(mp4)){
   const info=await media.probe(mp4);
   console.log('PROBE',JSON.stringify({liveId,duration:info.format.duration,streams:info.streams.map(({codec_type,codec_name,width,height,duration,start_time,nb_frames})=>({codec_type,codec_name,width,height,duration,start_time,nb_frames}))}));
  }
 }
})().catch(e=>{console.log('DIAG_ERROR',e.preset?e.message:'internal');process.exitCode=1;});
NODE
