set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{execFileSync}=require('child_process');
for(const id of ['1323410706013163520','1323401690805506048']){
 const dir='/app/recordings/.official-replays/'+id;
 const c=JSON.parse(fs.readFileSync(dir+'/complete.json'));
 const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height,duration','-of','json',dir+'/verified.mp4']));
 console.log(JSON.stringify({id,complete:c,probe:info}));
}
NODE
