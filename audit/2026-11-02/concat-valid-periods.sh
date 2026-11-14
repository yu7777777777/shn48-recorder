set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{spawnSync}=require('child_process');
for(const liveId of ['1323430498988265472','1323043490600128512']){
 const dir='/app/recordings/.replay-diagnostics-20261102/'+liveId;
 const names=fs.readdirSync(dir).filter(n=>/^period-\d+\.mp4$/.test(n));fs.writeFileSync(dir+'/concat.txt',names.map(n=>"file '"+n+"'").join('\n'));
 const r=spawnSync('ffmpeg',['-v','warning','-y','-f','concat','-safe','0','-i',dir+'/concat.txt','-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart',dir+'/normalized.mp4'],{encoding:'utf8'});
 const info=JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,duration,nb_frames','-of','json',dir+'/normalized.mp4'],{encoding:'utf8'}).stdout);
 console.log(JSON.stringify({liveId,exit:r.status,warnings:r.stderr.split('\n').filter(Boolean).slice(-5),...info}));
}
NODE
