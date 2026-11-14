set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
EXPECTED_BASE=sha256:c48c3c5b5497505ca3534d89f41460609a69bc47acb92db35ad747418704adfa
test "$(readlink -f /opt/shn48)" = /opt/shn48
test "$(docker inspect shn48-recorder --format '{{.Image}}')" = "$EXPECTED_BASE"
cmp -s docker-compose.yml "$REL/docker-compose.yml.before"
cmp -s docker-compose.public.yml "$REL/docker-compose.public.yml.before"
docker image inspect shn48-shn48:1.31.2 >/dev/null
docker exec shn48-recorder node -e 'const fs=require("fs");let n=0;for(const p of fs.readdirSync("/proc")){try{if(fs.readFileSync(`/proc/${p}/comm`,"utf8").trim()==="ffmpeg")n++}catch{}}console.log("ACTIVE_FFMPEG="+n);if(n)process.exit(9)'
sha256sum .env config/config.yaml > "$REL/protected-config.before.sha256"
cat > "$REL/rollback.sh" <<'ROLLBACK'
#!/bin/bash
set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
cp -p "$REL/docker-compose.yml.before" docker-compose.yml
cp -p "$REL/docker-compose.public.yml.before" docker-compose.public.yml
if [ -f "$REL/VERSION.before" ]; then cp -p "$REL/VERSION.before" VERSION; fi
if docker container inspect shn48-recorder >/dev/null 2>&1; then docker stop --time 30 shn48-recorder; docker rm shn48-recorder; fi
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build
ROLLBACK
chmod 700 "$REL/rollback.sh"
rollback_on_error() { rc=$?; trap - ERR; echo "CUTOVER_FAILED rc=$rc; rolling back"; bash "$REL/rollback.sh" > "$REL/rollback.log" 2>&1 || echo ROLLBACK_NEEDS_ATTENTION; exit "$rc"; }
trap rollback_on_error ERR
python3 - <<'PY'
from pathlib import Path
import re
p=Path('docker-compose.yml');s=p.read_text();out,n=re.subn(r'(?m)^(\s*image:\s*)shn48-shn48:1\.31\.1-fe\s*$',r'\g<1>shn48-shn48:1.31.2',s)
assert n==1,n
p.write_text(out)
PY
docker-compose -f docker-compose.yml -f docker-compose.public.yml config --services
date -Is | tee "$REL/cutover-start.txt"
docker stop --time 30 shn48-recorder
docker rm shn48-recorder
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build
python3 - <<'PY'
import time,urllib.request,json,subprocess,pathlib
p=pathlib.Path('/opt/shn48/releases/1.31.2')
for _ in range(60):
 try:
  with urllib.request.urlopen('http://127.0.0.1:3000/api/public/health',timeout=3) as r:d=json.load(r)
  state=json.loads(subprocess.check_output(['docker','inspect','shn48-recorder']))[0]
  if d.get('data',{}).get('version')=='1.31.2' and state['State'].get('Health',{}).get('Status')=='healthy':break
 except Exception:pass
 time.sleep(2)
else:raise SystemExit('Health readiness failed')
assert state['Config']['Image']=='shn48-shn48:1.31.2'
assert state['RestartCount']==0
expected={'/opt/shn48/runtime/recordings':'/app/recordings','/opt/shn48/runtime/data':'/app/data','/opt/shn48/config':'/app/config','/opt/shn48/runtime/biliup':'/app/biliup'}
assert {x['Source']:x['Destination'] for x in state['Mounts']}==expected
res=subprocess.run(['docker','exec','-i','shn48-recorder','sh','-c','cd /app && sha256sum -c -'],input=(p/'RUNTIME-SHA256SUMS').read_bytes(),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
(p/'runtime-verify.log').write_bytes(res.stdout+res.stderr)
assert res.returncode==0,'Runtime SHA256 mismatch'
summary={'health':d,'image':state['Config']['Image'],'imageId':state['Image'],'state':state['State']['Status'],'healthStatus':state['State']['Health']['Status'],'restartCount':state['RestartCount'],'runtimeFilesVerified':len((p/'RUNTIME-SHA256SUMS').read_text().splitlines()),'mounts':expected}
(p/'deploy-result.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
PY
sha256sum -c "$REL/protected-config.before.sha256"
cp -p "$REL/stage/VERSION" /opt/shn48/VERSION
date -Is | tee "$REL/cutover-complete.txt"
trap - ERR
echo DEPLOYED_VERIFIED
# Health passed: inspect stopped containers before any cleanup.
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-after.txt"
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
