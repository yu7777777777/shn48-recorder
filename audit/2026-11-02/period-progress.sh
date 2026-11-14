set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{execFileSync}=require('child_process');
for(const id of ['1323430498988265472','1323043490600128512']){
 const dir='/app/recordings/.replay-diagnostics-20261102/'+id;
 for(const n of fs.readdirSync(dir).filter(n=>/^period-\d+\.mp4$|^normalized\.mp4$/.test(n))){try{const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,duration,nb_frames','-of','json',dir+'/'+n]));console.log(JSON.stringify({id,n,...info}))}catch{}}
}
NODE
