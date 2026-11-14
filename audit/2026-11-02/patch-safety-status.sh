set -euo pipefail
docker exec -i shn48-recorder node <<'JS'
const fs=require('fs');const out=[];
for(const pid of fs.readdirSync('/proc')){try{
 if(fs.readFileSync('/proc/'+pid+'/comm','utf8').trim()!=='ffmpeg')continue;
 const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');const input=args[args.indexOf('-i')+1];
 if(!input?.endsWith('replay.processing.mp4'))continue;
 const size=fs.statSync(input).size;
 for(const fd of fs.readdirSync('/proc/'+pid+'/fd')){try{
  if(fs.readlinkSync('/proc/'+pid+'/fd/'+fd)!==input)continue;
  const m=/^pos:\s*(\d+)/m.exec(fs.readFileSync('/proc/'+pid+'/fdinfo/'+fd,'utf8'));
  if(m)out.push({temporaryReplay:true,inputReadPercent:Math.round(Number(m[1])/size*100)});
 }catch{}}
}catch{}}
console.log(JSON.stringify({temporaryReplayChecks:out}));
JS
curl -fsS --max-time 10 http://127.0.0.1:3000/api/public/health
echo
