#!/usr/bin/env bash
set -e
NAME=shn48-recorder
echo "=== recordings index summary (read-only) ==="
docker exec $NAME node -e '
const fs=require("fs");
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return f}};
const recs=read("/app/data/recordings.json",[]);
const counts={};
for(const r of recs) counts[r.status]=(counts[r.status]||0)+1;
console.log("recordings total:",recs.length,"by status:",JSON.stringify(counts));
const active=["recording","processing","waiting_merge"].filter(s=>counts[s]);
console.log("active-status records:",active.length?JSON.stringify(active.map(s=>[s,counts[s]])):"none");
const recent=recs.filter(r=>r.status==="recording"||r.status==="processing");
for(const r of recent) console.log(" ACTIVE",r.id,r.status,r.liveId||"",r.filePath||"");
const q=read("/app/data/upload_queue.json",[]);
const qc={};for(const i of q) qc[i.status]=(qc[i.status]||0)+1;
console.log("upload queue total:",q.length,"by status:",JSON.stringify(qc));
const busy=q.filter(i=>["uploading","queued","paused_recording","waiting_credentials"].includes(i.status));
console.log("upload busy (queued/uploading/etc):",busy.length);
'
echo "=== running ffmpeg processes ==="
docker exec $NAME sh -c 'ps -eo args | grep "[f]fmpeg" | head -5; echo "count=$(ps -eo args | grep -c "[f]fmpeg")"'
echo "=== analysis queue ==="
docker exec $NAME node -e '
const fs=require("fs");
try{const j=JSON.parse(fs.readFileSync("/app/data/analysis_jobs.json","utf8"));const c={};for(const x of j)c[x.status]=(c[x.status]||0)+1;console.log("analysis jobs:",j.length,JSON.stringify(c));}catch(e){console.log("analysis jobs: unreadable",e.message)}
'
