set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path');
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 for(const liveId of ['1323430498988265472','1323043490600128512']){
  const directory='/app/data/.replay-diagnostics-20261102/'+liveId;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const old='/app/recordings/.replay-diagnostics-20261102/'+liveId+'/plan.json';
  if(fs.existsSync(old))fs.copyFileSync(old,directory+'/plan.json');
  console.log('REFETCH',liveId);
  try{await media.download({liveId,directory,verify:false})}catch(e){if(!e.preset||!e.message.includes('时长与完整分片'))throw e;console.log('SOURCE_READY',liveId)}
 }
})().catch(e=>{console.error(e.preset?e.message:'Fixture preparation failed');process.exitCode=1});
NODE
