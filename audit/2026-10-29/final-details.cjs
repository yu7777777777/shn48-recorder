'use strict';
const fs=require('fs');
function read(f,defaultValue){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return defaultValue;}}
(async()=>{
const o={sampledAt:new Date().toISOString()};
try{const api=require('./modules/pocket48/api');const s=await api.getAuthStatus();o.pocketAuth=Object.fromEntries(Object.entries(s).filter(([k])=>['authenticated','health','state','upstreamAvailable','tokenPresent','lastCheckedAt'].includes(k)));const c=await api.getCheckinInfo();o.checkinReadOnly={http:c.status,business:c.data?.status,contentKeys:Object.keys(c.data?.content||{}),checked:['hasCheck','isCheckin','checked','isCheckIn'].some(k=>[true,1].includes(c.data?.content?.[k]))};}catch(e){o.pocketAuth={error:e.code||e.name};}
const js=read('/app/data/analysis_jobs.json',[]);o.analysisJobKeys=Object.keys(js[0]||{});o.lastJobs=js.slice(-10).map(j=>({kind:j.kind,status:j.status,createdAt:j.createdAt,startedAt:j.startedAt,endedAt:j.endedAt,errorCode:j.errorCode,attempts:j.attempts,retryCount:j.retryCount}));
const a=read('/app/data/auto_recording.json',{});o.auto={enabled:a.config?.enabled,minFreeGiB:a.config?.minFreeGiB,tracked:Object.keys(a.state?.lives||{}).length};
try{const r=await fetch('http://127.0.0.1:3000/api/public/live',{signal:AbortSignal.timeout(12000)});const d=await r.json();o.live={http:r.status,count:d.data?.list?.length,members:(d.data?.list||[]).map(v=>({id:v.member?.id,name:v.member?.name})),selectedLiveCount:(d.data?.list||[]).filter(v=>(a.config?.members||[]).some(m=>m.enabled&&String(m.memberId)===String(v.member?.id))).length};}catch(e){o.live={error:e.name};}
const checkin=read('/app/data/auto-checkin.json',{});o.autoCheckin={enabled:checkin.enabled,lastDate:checkin.lastDate,nextAt:typeof checkin.nextAt==='number'?new Date(checkin.nextAt).toISOString():checkin.nextAt,lastResult:checkin.lastResult};
console.log(JSON.stringify(o));process.exit(0);
})().catch(e=>{console.log(JSON.stringify({error:e.name}));process.exit(1);});
