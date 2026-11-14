set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),{spawnSync}=require('child_process'),media=require('/app/server/modules/recorder/replay-download');
const dir='/app/data/.replay-repair-two-20261102/1323410706013163520';const plan=JSON.parse(fs.readFileSync(dir+'/plan.json'));const periods=media.continuityPeriods(plan.local);
function run(bin,args){const r=spawnSync(bin,args,{encoding:'utf8'});if(r.status!==0)throw Error(bin+' failed '+r.stderr.slice(-400));return r.stdout;}
function probe(file){return JSON.parse(run('ffprobe',['-v','error','-i',file,'-count_packets','-show_entries','format=duration,start_time:stream=codec_type,nb_read_packets,duration,start_time','-of','json']));}
let expected={video:0,audio:0},entries={video:[],audio:[]};
for(const [i,p] of periods.entries()){
 const input=dir+'/track-source-'+i+'.m3u8';fs.writeFileSync(input,p.local);
 const flags=['-v','error','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',input];
 const source=JSON.parse(run('ffprobe',[...flags,'-count_packets','-show_entries','stream=codec_type,nb_read_packets','-of','json']));let duration=p.seconds;const tracks={};
 for(const type of ['video','audio']){
  const stream=source.streams.find(s=>s.codec_type===type);if(!stream)continue;
  const name='track-'+type+'-'+i+'.mp4',file=dir+'/'+name;
  run('ffmpeg',['-v','error','-y','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-copyts','-start_at_zero','-i',input,'-map',type==='video'?'0:v:0':'0:a:0','-c','copy',...(type==='video'?['-bsf:v',"setts=duration='max(DURATION,1)'"]:[]),file]);
  const out=probe(file),packets=Number(out.streams[0].nb_read_packets);if(packets!==Number(stream.nb_read_packets))throw Error(type+' packet mismatch at '+i+' '+packets+'/'+stream.nb_read_packets);
  expected[type]+=packets;duration=Math.max(duration,Number(out.format.duration));tracks[type]={name,info:out};
 }
 for(const type of ['video','audio'])if(tracks[type])entries[type].push({name:tracks[type].name,duration});else if(entries[type].length)entries[type].at(-1).duration+=duration;else throw Error('Unsupported leading missing stream');
 console.log('TRACK_PERIOD',JSON.stringify({i,seconds:p.seconds,duration,tracks}));
}
for(const type of ['video','audio'])fs.writeFileSync(dir+'/'+type+'.ffconcat','ffconcat version 1.0\n'+entries[type].map(x=>`file '${x.name}'\ninpoint 0\nduration ${x.duration}`).join('\n')+'\n');
const out=dir+'/tracks-repaired.mp4';run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',dir+'/video.ffconcat','-f','concat','-safe','0','-i',dir+'/audio.ffconcat','-map','0:v:0','-map','1:a:0','-c','copy','-bsf:v',"setts=duration='max(DURATION,1)'",'-movflags','+faststart',out]);
const result=probe(out);for(const s of result.streams)if(Number(s.nb_read_packets)!==expected[s.codec_type])throw Error('Final packet mismatch '+s.codec_type);console.log('RESULT',JSON.stringify({expected,result}));
NODE

