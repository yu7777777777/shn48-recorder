set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 for(const liveId of ['1323410706013163520','1323401690805506048']){
  const directory='/app/data/.replay-repair-two-20261102/'+liveId;
  try{const r=await media.download({liveId,directory,verify:false});console.log('DOWNLOAD',JSON.stringify({liveId,duration:r.durationSeconds,sha256:r.sha256,segments:r.segments}));}
  catch(e){console.log('DOWNLOAD_FAILED',liveId,e.preset?e.message:e.code||e.name);}
  const file=directory+'/plan.json';if(!fs.existsSync(file))continue;
  const p=JSON.parse(fs.readFileSync(file));const periods=media.continuityPeriods(p.local);
  console.log('PERIODS',JSON.stringify({liveId,periods:periods.map(x=>({seconds:x.seconds,segments:x.segments}))}));
  for(const [i,period] of periods.entries()){
   if(period.seconds>2)continue;
   const input=directory+'/short-'+i+'.m3u8';fs.writeFileSync(input,period.local,{mode:0o600});
   const flags=['-v','error','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',input];
   const info=spawnSync('ffprobe',[...flags,'-show_packets','-show_entries','packet=codec_type,pts_time,dts_time,duration_time,size,flags','-of','json'],{encoding:'utf8'});
   console.log('SHORT_PACKETS',JSON.stringify({liveId,i,info:JSON.parse(info.stdout)}));
   for(const [label,extra] of [['default',[]],['copyts',['-copyts','-start_at_zero']],['keep',['-copyts','-start_at_zero','-copyinkf','-avoid_negative_ts','make_zero']]]){
    const out=directory+'/short-'+i+'-'+label+'.mp4';
    const args=['-v','warning','-y','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL',...extra.slice(0,extra.indexOf('-copyinkf')<0?extra.length:extra.indexOf('-copyinkf')),'-i',input,'-map','0:v:0','-map','0:a?','-c','copy',...(label==='keep'?['-copyinkf','-avoid_negative_ts','make_zero']:[]),out];
    const r=spawnSync('ffmpeg',args,{encoding:'utf8'});
    const probe=spawnSync('ffprobe',['-v','error','-i',out,'-count_packets','-count_frames','-show_entries','stream=codec_type,nb_read_packets,nb_read_frames,duration','-of','json'],{encoding:'utf8'});
    console.log('SHORT_MUX',JSON.stringify({liveId,i,label,exit:r.status,warnings:r.stderr.split('\n').filter(Boolean).slice(-5),info:probe.stdout?JSON.parse(probe.stdout):null}));
   }
  }
 }
})().catch(e=>{console.log('DIAG_FAIL',e.code||e.name);process.exitCode=1});
NODE
