set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.32.2
test "$(readlink -f /opt/shn48)" = /opt/shn48
test "$(cat "$REL/build.exit")" = 0
test "$(docker inspect shn48-recorder -f '{{.Image}}')" = sha256:7db4b15a8285b1eae1aa40afdd69b8c3cb6119e612742bd15b5aa8469cff377c
test "$(docker image inspect shn48-shn48:1.32.2 -f '{{.Id}}')" = "$(cat "$REL/candidate-image-id.txt")"
cmp -s docker-compose.yml "$REL/docker-compose.yml.before"
cmp -s docker-compose.public.yml "$REL/docker-compose.public.yml.before"
test -s "$REL/candidate-smoke.log"
docker exec -i shn48-recorder node <<'JS'
const fs=require('fs');let media=0,readonlyChecks=0;
const archives=JSON.parse(fs.readFileSync('/app/data/recordings.json','utf8'));
const mainFiles=new Set(archives.filter(r=>r.status==='done'&&r.filePath).map(r=>r.filePath));
for(const pid of fs.readdirSync('/proc')){if(!/^\d+$/.test(pid))continue;try{
 const comm=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();
 if(!['ffmpeg','ffprobe','biliup','python','python3'].includes(comm))continue;
 const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
 const input=args[args.indexOf('-i')+1];
 if(comm==='ffmpeg'&&args.at(-1)==='-'&&args[args.indexOf('-f')+1]==='null'&&mainFiles.has(input))readonlyChecks++;
 else media++;
}catch{}}
const specs={recordings:['recording','processing','waiting_merge','merging','clip_queued','clip_processing'],upload_queue:['queued','uploading','processing','verifying'],analysis_jobs:['queued','running'],replay_import_jobs:['pending','querying','downloading','verifying','archiving'],export_jobs:['queued','running'],'backup115/jobs':['hashing','uploading','verifying']};
const active={};
const recovering=archives.filter(r=>['downloading','verifying','awaiting_archive'].includes(r.replayRecovery?.status)).length;
if(recovering)active.replayRecovery=recovering;
try{const audit=JSON.parse(fs.readFileSync('/app/data/replay_audit.json','utf8'));const n=Object.values(audit).filter(r=>r?.status==='repairing').length;if(n)active.replayAudit=n;}catch(e){if(e.code!=='ENOENT')throw e;}
for(const [key,statuses] of Object.entries(specs)){
 try{const rows=JSON.parse(fs.readFileSync('/app/data/'+key+'.json','utf8'));if(!Array.isArray(rows))throw Error('invalid state');const n=rows.filter(r=>statuses.includes(r.status)).length;if(n)active[key]=n;}catch(e){if(e.code!=='ENOENT')throw e;}
}
console.log(JSON.stringify({mediaProcesses:media,readonlyArchiveChecks:readonlyChecks,activeTasks:active}));
if(media||Object.keys(active).length)process.exit(9);
JS
sha256sum .env config/config.yaml runtime/data/admin-credentials.json > "$REL/protected-config.before.sha256"
docker exec -i shn48-recorder node > "$REL/archive-files.before.json" <<'JS'
const fs=require('fs');const rows=JSON.parse(fs.readFileSync('/app/data/recordings.json','utf8'));
const files=rows.filter(r=>r.status==='done'&&r.filePath).map(r=>{const s=fs.statSync(r.filePath);return {id:r.id,path:r.filePath,size:s.size,mtimeMs:s.mtimeMs,ino:s.ino};});
console.log(JSON.stringify(files));
JS
cat > "$REL/rollback.sh" <<'ROLLBACK'
#!/bin/bash
set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.32.2
cp -p "$REL/docker-compose.yml.before" docker-compose.yml
cp -p "$REL/docker-compose.public.yml.before" docker-compose.public.yml
cp -p "$REL/VERSION.before" VERSION
if docker container inspect shn48-recorder >/dev/null 2>&1; then docker stop --time 40 shn48-recorder; docker rm shn48-recorder; fi
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build
ROLLBACK
chmod 700 "$REL/rollback.sh"
rollback_on_error(){ rc=$?; trap - ERR; echo "CUTOVER_FAILED rc=$rc; rolling back"; bash "$REL/rollback.sh" > "$REL/rollback.log" 2>&1 || echo ROLLBACK_NEEDS_ATTENTION; exit "$rc"; }
trap rollback_on_error ERR
python3 - <<'PY'
from pathlib import Path
import re
p=Path('docker-compose.yml');s=p.read_text()
out,n=re.subn(r'(?m)^(\s*image:\s*)shn48-shn48:1\.32\.1\s*$',r'\g<1>shn48-shn48:1.32.2',s)
assert n==1,n
p.write_text(out)
PY
docker-compose -f docker-compose.yml -f docker-compose.public.yml config --services
date -Is | tee "$REL/cutover-start.txt"
docker stop --time 40 shn48-recorder
# Snapshot only JSON runtime metadata while the service is stopped; no old data is restored.
STATE_BACKUP=/opt/shn48/backups/release-1.32.2-20261102-r2
mkdir -p /opt/shn48/backups
mkdir -m 700 "$STATE_BACKUP"
find runtime/data -maxdepth 1 -type f -name '*.json' -exec cp -p --parents {} "$STATE_BACKUP/" \;
chmod -R go-rwx "$STATE_BACKUP"

python3 "$REL/prepare-replay-retry.py"
docker rm shn48-recorder
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build
python3 - <<'PY'
import time,urllib.request,json,subprocess,pathlib
p=pathlib.Path('/opt/shn48/releases/1.32.2')
for _ in range(60):
 try:
  with urllib.request.urlopen('http://127.0.0.1:3000/api/public/health',timeout=3) as r:d=json.load(r)
  state=json.loads(subprocess.check_output(['docker','inspect','shn48-recorder']))[0]
  if d.get('data',{}).get('version')=='1.32.2' and state['State'].get('Health',{}).get('Status')=='healthy':break
 except Exception:pass
 time.sleep(2)
else:raise SystemExit('Health readiness failed')
assert state['Config']['Image']=='shn48-shn48:1.32.2'
assert state['RestartCount']==0
expected={'/opt/shn48/runtime/recordings':'/app/recordings','/opt/shn48/runtime/data':'/app/data','/opt/shn48/config':'/app/config','/opt/shn48/runtime/biliup':'/app/biliup'}
assert {x['Source']:x['Destination'] for x in state['Mounts']}==expected
before=json.loads((p/'archive-files.before.json').read_text())
script='const fs=require("fs");const files='+json.dumps(before)+';for(const f of files){const s=fs.statSync(f.path);if(s.size!==f.size||s.mtimeMs!==f.mtimeMs||s.ino!==f.ino)throw Error("Archive changed: "+f.id)}console.log("ARCHIVE_MAIN_FILES_UNCHANGED="+files.length)'
subprocess.run(['docker','exec','shn48-recorder','node','-e',script],check=True)
res=subprocess.run(['docker','exec','-i','shn48-recorder','sh','-c','cd /app && sha256sum -c -'],input=(p/'RUNTIME-SHA256SUMS').read_bytes(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
(p/'runtime-verify.log').write_bytes(res.stdout+res.stderr)
assert res.returncode==0,'Runtime SHA256 mismatch'
summary={'health':d,'image':state['Config']['Image'],'imageId':state['Image'],'state':state['State']['Status'],'healthStatus':state['State']['Health']['Status'],'restartCount':state['RestartCount'],'runtimeFilesVerified':len((p/'RUNTIME-SHA256SUMS').read_text().splitlines()),'archiveMainFilesUnchanged':len(before),'mounts':expected}
(p/'deploy-result.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
PY
sha256sum -c "$REL/protected-config.before.sha256"
cp -p "$REL/stage-r3/VERSION" VERSION
date -Is | tee "$REL/cutover-complete.txt"
trap - ERR
echo DEPLOYED_VERIFIED
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-after.txt"

