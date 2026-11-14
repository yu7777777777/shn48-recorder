set -euo pipefail
cd /opt/shn48
docker image inspect shn48-shn48:1.31.1-fe --format 'BASE_USER={{json .Config.User}}'
docker inspect shn48-recorder --format '{{.State.Health.Status}} {{.Image}} {{.RestartCount}}'
docker exec shn48-recorder node -e 'const fs=require("fs");let n=0;for(const p of fs.readdirSync("/proc")){try{if(fs.readFileSync(`/proc/${p}/comm`,"utf8").trim()==="ffmpeg")n++}catch{}}console.log("ACTIVE_FFMPEG="+n);if(n)process.exit(9)'
