set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs');for(const dir of ['/app/recordings/.official-replays/1323410706013163520','/app/recordings/.official-replays/1323410706013163520/audit-timeline-v1']){try{const v=JSON.parse(fs.readFileSync(dir+'/validation.json'));console.log(JSON.stringify(v))}catch{}}
NODE
