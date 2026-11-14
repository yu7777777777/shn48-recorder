'use strict';
// Materialize verified official replays into a dedicated staging fs by copying existing segments.
// Leaf modules only: no recorder manager / import jobs / recovery scan.
const fs=require('fs'),path=require('path');
const source='/app/data/recovery-20261026-29';
const stagingData='/app/data/recovery-staging';
const stagingFs='/recordings/recovery-import-staging';
for(const dir of [stagingData+'/isolated-state',stagingData+'/isolated-home',stagingFs])fs.mkdirSync(dir,{recursive:true,mode:0o700});
process.env.DATA_DIR=stagingData+'/isolated-state';process.env.POCKET48_DATA_DIR=stagingData+'/isolated-state';process.env.HOME=stagingData+'/isolated-home';process.env.RECORDINGS_DIR=stagingFs;
const media=require('/app/server/modules/recorder/replay-download');
const replay=require('/app/server/modules/pocket48/replay');
const proxy=require('/app/server/modules/pocket48/replay-proxy')._internals;
const lives=[{liveId:'1321966661005021184',memberId:'64422010',memberName:'熊紫轶',title:'你好的坏的',startedAt:'2026-10-27T14:23:33.633Z',durationSeconds:9704},{liveId:'1322332610476445696',memberId:'64422010',memberName:'熊紫轶',title:'你好的坏的',startedAt:'2026-10-28T14:37:42.806Z',durationSeconds:10214}];
const THRESHOLD=8*2**30;
function free(){const s=fs.statfsSync(stagingFs);return s.bavail*s.bsize;}
function emit(x){console.log(JSON.stringify({at:new Date().toISOString(),...x}));}
function guard(extra=0){const f=free();if(f<THRESHOLD+extra)throw Object.assign(new Error('暂缓：为直播保留8GiB空间'),{code:'RECOVERY_RESERVE',freeGiB:f/2**30});return f;}
function load(){try{return JSON.parse(fs.readFileSync(source+'/results.json','utf8'));}catch{return{results:[]};}}
(async()=>{
const result=load();const out={at:new Date().toISOString(),source,stagingFs,thresholdGiB:8,results:[]};
emit({event:'started',freeGiB:free()/2**30,thresholdGiB:8});
for(const meta of lives){let last=0,lastPercent=-1;emit({event:'download_start',liveId:meta.liveId,durationSeconds:meta.durationSeconds,freeGiB:free()/2**30});
try{
const official=await media.download({liveId:meta.liveId,directory:stagingFs+'/'+meta.liveId,verify:true,request:async(...args)=>{guard();return proxy.upstreamRequest(...args);},onProgress(p){guard();if(p.verifying)guard(Math.ceil(p.bytes*1.1));const percent=p.total?Math.floor(p.completed/p.total*100):0;if(Date.now()-last>20000||percent>=lastPercent+15||p.verifying){last=Date.now();lastPercent=percent;emit({event:p.verifying?'verifying':'progress',liveId:meta.liveId,percent,bytes:p.bytes,freeGiB:free()/2**30});}}});
if(official.verification!=='full'||!fs.existsSync(official.filePath)||fs.statSync(official.filePath).size!==official.size||Math.abs(official.durationSeconds-meta.durationSeconds)>Math.max(3,meta.durationSeconds*.005))throw Object.assign(new Error('媒体时长或完整性未对齐'),{code:'RECOVERY_VALIDATION'});
const row={...meta,status:'preserved',...official,archiveRegistered:false,preservedAt:new Date().toISOString()};out.results.push(row);const i=result.results.findIndex(r=>r.liveId===meta.liveId);if(i>=0)result.results[i]=row;else result.results.push(row);media.atomicJson(source+'/results.json',result);media.atomicJson(path.dirname(official.filePath)+'/recovery-metadata.json',row);emit({event:'preserved',liveId:meta.liveId,size:official.size,durationSeconds:official.durationSeconds,verification:official.verification,freeGiB:free()/2**30});
}catch(e){emit({event:'failed',liveId:meta.liveId,code:e.code||e.name,message:/^[\u4e00-\u9fff]/.test(e.message||'')?e.message:'下载处理失败',freeGiB:free()/2**30});out.results.push({liveId:meta.liveId,status:'failed',code:e.code||e.name});}}
media.atomicJson(stagingData+'/materialize-results.json',out);emit({event:'finished',results:out.results.map(({liveId,status,size,verification})=>({liveId,status,size,verification})),freeGiB:free()/2**30});process.exit(out.results.every(r=>r.status==='preserved')?0:2);
})().catch(e=>{emit({event:'fatal',code:e.code||e.name});process.exit(1);});
