set -euo pipefail
docker exec -i shn48-recorder node <<'JS'
const fs=require('fs');
const counts={};
for(const key of ['recordings','upload_queue','analysis_jobs','backup115_jobs','replay_import_jobs','export_jobs']){
 try { const data=JSON.parse(fs.readFileSync('/app/data/'+key+'.json','utf8')); const rows=Array.isArray(data)?data:(data.jobs||data.items||[]); counts[key]={}; for(const r of rows) counts[key][r.status||'unknown']=(counts[key][r.status||'unknown']||0)+1; } catch(e){counts[key]={missing:e.code==='ENOENT'};}
}
const processes={};
for(const pid of fs.readdirSync('/proc')){if(!/^\d+$/.test(pid))continue;try{const name=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();processes[name]=(processes[name]||0)+1;}catch{}}
console.log(JSON.stringify({counts,processes}));
JS
REL=/opt/shn48/releases/1.32.0
for f in frontend-build.log image-build.log server-tests.log client-tests.log build.exit; do if test -f "$REL/$f"; then echo "$f"; tail -n 7 "$REL/$f"; fi; done
