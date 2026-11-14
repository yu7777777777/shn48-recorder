set -euo pipefail
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs');
const audit=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));
const recordings=JSON.parse(fs.readFileSync('/app/data/recordings.json'));
for(const id of ['rec_1793460029674_k5sw2','rec_1793367807736_1gszb','rec_1793455319510_jc46a','rec_1793453189443_mbo87']){
 const a=audit[id],r=recordings.find(r=>r.id===id);
 console.log(JSON.stringify({id,status:a?.status,reason:a?.reason,error:a?.error,localSeconds:a?.localSeconds,officialSeconds:a?.officialSeconds,downloadableSeconds:a?.downloadableSeconds,attempts:a?.attempts,nextAttemptAt:a?.nextAttemptAt,archiveStatus:r?.status,archiveDuration:r?.durationSeconds,archiveVersion:r?.archiveVersion,replayAuditStatus:r?.replayAudit?.status}));
}
for(const pid of fs.readdirSync('/proc')){if(!/^\d+$/.test(pid))continue;try{
 const comm=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();if(!['ffmpeg','ffprobe'].includes(comm))continue;
 const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');
 const input=args[args.indexOf('-i')+1];
 console.log(JSON.stringify({process:comm,pid,input:input?.startsWith('/app/')?input:'external'}));
}catch{}}
NODE
docker inspect shn48-recorder --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}'
