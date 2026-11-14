set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.32.3
docker inspect shn48-recorder --format '{{.Config.Image}} {{.Image}} {{.State.Health.Status}} {{.RestartCount}}'
docker exec -i shn48-recorder sh -c 'cd /app && sha256sum -c -' < "$REL/RUNTIME-SHA256SUMS" > "$REL/runtime-verify-final.log"
sha256sum -c "$REL/protected-config.before.sha256"
docker exec -i shn48-recorder node <<'NODE' | tee "$REL/repair-results-final.jsonl"
const fs=require('fs');const a=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));const r=JSON.parse(fs.readFileSync('/app/data/recordings.json'));
for(const id of ['rec_1793460029674_k5sw2','rec_1793367807736_1gszb','rec_1793455319510_jc46a','rec_1793453189443_mbo87']){
const x=a[id],y=r.find(z=>z.id===id);console.log(JSON.stringify({id,status:x.status,reason:x.reason,error:x.error,local:x.localSeconds,official:x.officialSeconds,downloadable:x.downloadableSeconds,next:x.nextAttemptAt,archive:y.durationSeconds,origin:y.archiveOrigin,replayAudit:y.replayAudit?.status}));
if(x.nextAttemptAt||!['repaired_local_published','repaired_local','manual'].includes(x.status))throw Error('Repair unresolved');
}
for(const id of ['rec_1793460029674_k5sw2','rec_1793367807736_1gszb']){
 const y=r.find(z=>z.id===id);const c=JSON.parse(fs.readFileSync(require('path').join(require('path').dirname(y.filePath),'complete.json')));
 if(c.verification!=='full'||c.sha256!==y.fileSha256)throw Error('Not fully verified');
 if(!fs.existsSync(y.replayAudit.originalFile))throw Error('Original missing');
 console.log(JSON.stringify({id,verification:c.verification,sha256:c.sha256,originalPreserved:true,postedArchiveOnly:true}));
}
NODE
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-final.txt"
if test ! -s "$REL/stopped-containers-final.txt"; then echo 'No stopped containers; cleanup count=0; rollback images retained.' | tee "$REL/container-cleanup-result.txt"; fi
docker image inspect shn48-shn48:rollback-1.32.1-20261102 --format 'ROLLBACK_1.32.1={{.Id}}'
docker image inspect shn48-shn48:rollback-1.32.2-20261102 --format 'ROLLBACK_1.32.2={{.Id}}'
curl -fsS --max-time 15 http://127.0.0.1:3000/api/public/health
echo
