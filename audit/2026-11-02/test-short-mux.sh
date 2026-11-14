set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{spawnSync}=require('child_process');
const dir='/app/data/.replay-repair-two-20261102/1323410706013163520';
const input=dir+'/short-1.m3u8';
const src=spawnSync('ffprobe',['-v','error','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',input,'-count_frames','-show_entries','stream=codec_type,nb_read_frames,duration,r_frame_rate,avg_frame_rate','-of','json'],{encoding:'utf8'});console.log('SOURCE_DECODE',src.stdout);
for(const [label,options,extension] of [['mkv',['-c','copy'],'mkv'],['nut',['-c','copy'],'nut'],['rate',['-c','copy','-r','20'],'mp4'],['encode',['-c:v','libx264','-threads','1','-fps_mode:v','vfr','-c:a','copy'],'mp4'],['duration',['-c','copy','-bsf:v','setts=duration=18000'],'mp4']]){
 const out=dir+'/short-test-'+label+'.'+extension;
 const mux=spawnSync('ffmpeg',['-v','warning','-y','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',input,'-map','0:v:0','-map','0:a?',...options,out],{encoding:'utf8'});
 const p=spawnSync('ffprobe',['-v','error','-i',out,'-count_packets','-count_frames','-show_entries','stream=codec_type,nb_frames,nb_read_packets,nb_read_frames,duration','-of','json'],{encoding:'utf8'});
 console.log(JSON.stringify({label,exit:mux.status,warnings:mux.stderr.split('\n').filter(Boolean).slice(-3),info:p.stdout?JSON.parse(p.stdout):null}));
}
NODE
