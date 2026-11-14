'use strict';
const fs=require('fs'),crypto=require('crypto');
const replay=require('./modules/pocket48/replay');
const start=Date.parse('2026-10-26T00:00:00+08:00'),end=Date.parse('2026-10-30T00:00:00+08:00');
function time(v){const s=String(v??'');return /^\d{10,13}$/.test(s)?Number(s)*(s.length===10?1000:1):Date.parse(s);}
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return f;}};
(async()=>{
const cfg=read('/app/data/auto_recording.json',{});const members=(cfg.config?.members||[]).filter(m=>m.enabled!==false);const recs=read('/app/data/recordings.json',[]);const pending=read('/app/data/replay_import_jobs.json',[]).filter(j=>['pending','querying','downloading','verifying','archiving'].includes(j.status));
const auth=read('/app/data/admin-credentials.json',null);let authChecks={credentialFileExists:!!auth,environmentPresent:!!process.env.ADMIN_PASSWORD};
if(auth?.password){try{const hash=Buffer.from(auth.password.hash,'base64'),salt=Buffer.from(auth.password.salt,'base64');authChecks.passwordMatches=crypto.timingSafeEqual(crypto.scryptSync(process.env.ADMIN_PASSWORD||'',salt,hash.length),hash);authChecks.usernameMatches=auth.username===process.env.ADMIN_USERNAME;}catch{}}
const stat=fs.statfsSync('/app/recordings');const out={sampledAt:new Date().toISOString(),host:require('os').hostname(),version:fs.readFileSync('/app/VERSION','utf8').trim(),freeGiB:stat.bavail*stat.bsize/2**30,authChecks,activeRecordingRows:recs.filter(r=>r.status==='recording').map(r=>({id:r.id,liveId:r.liveId})),pendingImportJobs:pending.map(j=>({id:j.id,liveId:j.liveId,status:j.status})),members:[],replays:[]};
for(const member of members){const id=String(member.memberId);let next='0',pages=0,covered=false;const seen=new Set(),found=[];let error;
try{while(pages<15){const r=await replay.listReplays({userId:id,next});pages++;const list=r.list||[];let oldest=Infinity;for(const v of list){if(String(v.member?.id)!==id)continue;const t=time(v.startedAt);if(Number.isFinite(t))oldest=Math.min(oldest,t);if(t>=start&&t<end&&!seen.has(v.liveId)){seen.add(v.liveId);const existing=recs.find(x=>String(x.liveId)===String(v.liveId)&&!['deleted','merged'].includes(x.status)&&x.filePath&&fs.existsSync(x.filePath));found.push({liveId:v.liveId,memberId:id,memberName:member.memberName||v.member?.name,title:v.title,startedAt:new Date(t).toISOString(),beijingDate:new Date(t+8*3600000).toISOString().slice(0,10),durationSeconds:v.durationSeconds,duration:v.duration,existing:existing?{id:existing.id,status:existing.status}:null});}}
if(oldest<start){covered=true;break;}const n=String(r.next||'0');if(!list.length||n==='0'||n===next){covered=true;break;}next=n;}
}catch(e){error={code:e.code||e.name,message:/^[\u4e00-\u9fff]/.test(e.message||'')?e.message:'upstream lookup failed'};}
out.members.push({memberId:id,memberName:member.memberName,pages,covered,found:found.length,error});out.replays.push(...found);}
out.replays.sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.memberId.localeCompare(b.memberId));console.log(JSON.stringify(out));process.exit(0);
})().catch(e=>{console.log(JSON.stringify({fatal:e.code||e.name}));process.exit(1);});
