set -eu
docker inspect shn48-recorder --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}'
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs');const a=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));const r=JSON.parse(fs.readFileSync('/app/data/recordings.json'));for(const id of ['rec_1793455319510_jc46a','rec_1793453189443_mbo87']){const x=a[id],y=r.find(z=>z.id===id);console.log(JSON.stringify({id,a:x,r:{filePath:y.filePath,duration:y.durationSeconds,size:y.size,archiveOrigin:y.archiveOrigin,replayAudit:y.replayAudit}}));}
NODE
