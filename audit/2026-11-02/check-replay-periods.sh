set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
for(const liveId of ['1323430498988265472','1323043490600128512']){
 const dir='/app/recordings/.replay-diagnostics-20261102/'+liveId;
 const p=JSON.parse(fs.readFileSync(dir+'/plan.json'));
 try{await media.verifyFull(dir+'/replay.processing.mp4');console.log('ORIGINAL_DECODE_OK',liveId)}catch(e){console.log('ORIGINAL_DECODE_FAIL',liveId)}
 const sections=p.local.split(/^#EXT-X-DISCONTINUITY\s*$/m);let i=0;
 for(const section of sections){
  const playlist=dir+'/period-'+i+'.m3u8',output=dir+'/period-'+i+'.mp4';
  const text=section.includes('#EXTM3U')?section:'#EXTM3U\n#EXT-X-TARGETDURATION:30\n#EXT-X-MEDIA-SEQUENCE:0\n'+section;
  fs.writeFileSync(playlist,text.includes('#EXT-X-ENDLIST')?text:text+'\n#EXT-X-ENDLIST\n');
  const r=spawnSync('ffmpeg',['-v','warning','-y','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',playlist,'-map','0:v:0','-map','0:a?','-c','copy',output],{encoding:'utf8'});
  const seconds=[...section.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s,m)=>s+Number(m[1]),0);
  let info;try{info=await media.probe(output)}catch{}
  console.log('PERIOD',JSON.stringify({liveId,i,manifest:seconds,exit:r.status,warningLines:r.stderr.split('\n').filter(Boolean).length,duration:info?.format.duration,streams:info?.streams.map(({codec_type,duration,start_time,nb_frames})=>({codec_type,duration,start_time,nb_frames}))}));i++;
 }
 const list=sections.map((_,i)=>"file 'period-"+i+".mp4'").join('\n');fs.writeFileSync(dir+'/concat.txt',list);
 const result=spawnSync('ffmpeg',['-v','warning','-y','-f','concat','-safe','0','-i',dir+'/concat.txt','-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart',dir+'/normalized.mp4'],{encoding:'utf8'});
 let info;try{info=await media.probe(dir+'/normalized.mp4')}catch{}
 console.log('NORMALIZED',JSON.stringify({liveId,exit:result.status,warningLines:result.stderr.split('\n').filter(Boolean).length,duration:info?.format.duration,streams:info?.streams.map(({codec_type,duration,nb_frames})=>({codec_type,duration,nb_frames}))}));
 try{await media.verifyFull(dir+'/normalized.mp4');console.log('NORMALIZED_DECODE_OK',liveId)}catch(e){console.log('NORMALIZED_DECODE_FAIL',liveId)}
}
})().catch(()=>process.exitCode=1);
NODE
