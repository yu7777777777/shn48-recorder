set -eu
df -h /opt/shn48
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs');const root='/app/recordings/.replay-diagnostics-20261102';
for(const id of fs.readdirSync(root)){const dir=root+'/'+id;const names=fs.readdirSync(dir);let p;try{p=JSON.parse(fs.readFileSync(dir+'/plan.json'))}catch{}console.log(JSON.stringify({id,files:names.length,planSeconds:p?.seconds,segments:p?.segments,completed:p&&Object.keys(p.completed).length,mp4:names.includes('replay.processing.mp4'),complete:names.includes('complete.json')}));}
NODE
