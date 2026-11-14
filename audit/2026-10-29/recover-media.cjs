'use strict';
// Leaf-module media preservation only; never load recorder manager or change its index.
const fs=require('fs'),path=require('path');
const root='/app/data/recovery-20261026-29';
fs.mkdirSync(root,{recursive:true,mode:0o700});
const sourceData='/app/data';
const original=JSON.parse(fs.readFileSync(sourceData+'/auto_recording.json','utf8'));
process.env.DATA_DIR=root+'/isolated-state';process.env.POCKET48_DATA_DIR=root+'/isolated-state';process.env.HOME=root+'/isolated-home';process.env.RECORDINGS_DIR=root+'/unused-recordings';
const media=require('/app/server/modules/recorder/replay-download');
const replay=require('/app/server/modules/pocket48/replay');
const proxy=require('/app/server/modules/pocket48/replay-proxy')._internals;
const lives=[{liveId:'1321554233301733376',memberId:'87622891',memberName:'刘小涵',title:'❤️聊天',startedAt:'2026-10-26T11:04:42.961Z',durationSeconds:6967},{liveId:'1321966661005021184',memberId:'64422010',memberName:'熊紫轶',title:'你好的坏的',startedAt:'2026-10-27T14:23:33.633Z',durationSeconds:9704},{liveId:'1322332610476445696',memberId:'64422010',memberName:'熊紫轶',title:'你好的坏的',startedAt:'2026-10-28T14:37:42.806Z',durationSeconds:10214}];
const minFree=8*2**30;
function free(){const s=fs.statfsSync(root);return s.bavail*s.bsize;}
function emit(x){console.log(JSON.stringify({at:new Date().toISOString(),...x}));}
function safe(){if(free()<minFree)throw Object.assign(new Error('补录暂缓：为当前直播保留8GiB空间'),{code:'RECOVERY_RESERVE'});}
function load(){try{return JSON.parse(fs.readFileSync(root+'/results.json','utf8'));}catch{return {startedAt:new Date().toISOString(),scope:'2026-10-26..29 Asia/Shanghai',autoUpload:false,results:[]};}}
const result=load();
(async()=>{
emit({event:'started',root,freeGiB:free()/2**30,liveIds:lives.map(x=>x.liveId)});
for(const meta of lives){safe();const i=result.results.findIndex(x=>x.liveId===meta.liveId);let lastTime=0,lastPercent=-1;const directory=root+'/'+meta.liveId;
try{
const existing=JSON.parse(fs.readFileSync(sourceData+'/recordings.json','utf8')).find(r=>String(r.liveId)===meta.liveId&&r.status==='done'&&r.filePath&&fs.existsSync(r.filePath));if(existing){emit({event:'already_archived',liveId:meta.liveId,recordingId:existing.id});continue;}
emit({event:'download_start',...meta,freeGiB:free()/2**30});
const official=await media.download({liveId:meta.liveId,directory,verify:true,request:async(...args)=>{safe();return proxy.upstreamRequest(...args);},onProgress(p){safe();const percent=p.total?Math.floor(p.completed/p.total*100):0;if(p.verifying&&free()<minFree+p.bytes*1.1)throw Object.assign(new Error('补录封装暂缓：空间不足以同时保留分片、MP4和直播预留'),{code:'RECOVERY_MUX_RESERVE'});if(Date.now()-lastTime>15000||percent>=lastPercent+10||p.verifying){lastTime=Date.now();lastPercent=percent;emit({event:p.verifying?'verifying':'progress',liveId:meta.liveId,percent,bytes:p.bytes,completed:p.completed,total:p.total,freeGiB:free()/2**30});}}});
if(official.verification!=='full'||!fs.existsSync(official.filePath)||fs.statSync(official.filePath).size!==official.size||Math.abs(official.durationSeconds-meta.durationSeconds)>Math.max(3,meta.durationSeconds*.005))throw Object.assign(new Error('下载媒体与官方场次时长未对齐'),{code:'RECOVERY_VALIDATION'});
const row={...meta,status:'preserved',...official,archiveRegistered:false,preservedAt:new Date().toISOString()};if(i>=0)result.results[i]=row;else result.results.push(row);media.atomicJson(root+'/results.json',result);media.atomicJson(directory+'/recovery-metadata.json',row);emit({event:'preserved',...row,freeGiB:free()/2**30});
}catch(e){const row={...meta,status:'failed',code:e.code||e.name,error:/^[\u4e00-\u9fff]/.test(e.message||'')?e.message:'下载处理失败，未丢弃原数据',failedAt:new Date().toISOString()};if(i>=0)result.results[i]=row;else result.results.push(row);media.atomicJson(root+'/results.json',result);emit({event:'failed',...row,freeGiB:free()/2**30});if(String(e.code||'').startsWith('RECOVERY_'))break;}}
result.finishedAt=new Date().toISOString();media.atomicJson(root+'/results.json',result);emit({event:'finished',results:result.results.map(({liveId,status,size,durationSeconds,verification})=>({liveId,status,size,durationSeconds,verification})),freeGiB:free()/2**30});
process.exit(result.results.filter(r=>r.status==='preserved').length===lives.length?0:2);
})().catch(e=>{emit({event:'fatal',code:e.code||e.name});process.exit(1);});
