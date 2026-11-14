set -euo pipefail
BASE=/opt/shn48
REL=$BASE/releases/1.31.2
test "$(readlink -f "$BASE")" = /opt/shn48
if [ -d "$REL" ]; then echo RELEASE_DIRECTORY_ALREADY_EXISTS; exit 9; fi
mkdir -p "$REL"
docker inspect shn48-recorder --format '{{.Config.Image}} {{.Image}} {{.State.Health.Status}} {{.RestartCount}}' | tee "$REL/baseline-image.txt"
cp -p "$BASE/docker-compose.yml" "$REL/docker-compose.yml.before"
cp -p "$BASE/docker-compose.public.yml" "$REL/docker-compose.public.yml.before"
if [ -f "$BASE/VERSION" ]; then cp -p "$BASE/VERSION" "$REL/VERSION.before"; fi
docker exec shn48-recorder sh -c 'cd /app && find server client/dist -type f ! -path "*/node_modules/*" ! -path "*/.cache/*" ! -name "*.log" -exec sha256sum {} \; ; sha256sum VERSION' > "$REL/baseline-runtime.sha256"
docker exec shn48-recorder node -e 'const fs=require("fs");let ff=0;for(const p of fs.readdirSync("/proc")){if(!/^\d+$/.test(p))continue;try{if(fs.readFileSync(`/proc/${p}/comm`,"utf8").trim()==="ffmpeg")ff++}catch{}}let counts={};try{const r=JSON.parse(fs.readFileSync("/app/data/recordings.json","utf8"));let a=Array.isArray(r)?r:Object.values(r.recordings||r);for(const x of a)counts[x.status]=(counts[x.status]||0)+1}catch(e){counts.error=e.code||e.message}console.log(JSON.stringify({ffmpegProcesses:ff,recordingStates:counts}));'
docker-compose -f "$BASE/docker-compose.yml" -f "$BASE/docker-compose.public.yml" config --services
docker ps -a --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
df -B1 /
