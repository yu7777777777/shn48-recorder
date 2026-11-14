set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{execFileSync}=require('child_process');
for(const id of ['1323430498988265472','1323043490600128512']){
 const dir='/app/recordings/.replay-diagnostics-20261102/'+id;
 for(const name of fs.readdirSync(dir).filter(n=>/^period-[1-4]\.m3u8$/.test(n))){
  const args=['-v','error','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',dir+'/'+name,'-count_packets','-show_entries','stream=codec_type,nb_read_packets','-of','json'];
  const info=JSON.parse(execFileSync('ffprobe',args,{stdio:['ignore','pipe','ignore']}));console.log(JSON.stringify({id,name,streams:info.streams}));
 }
}
NODE
