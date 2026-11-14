set -eu
docker exec -i shn48-recorder node <<'NODE'
const replay=require('/app/server/modules/pocket48/replay');
const proxy=require('/app/server/modules/pocket48/replay-proxy')._internals;
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 for(const id of ['1323410706013163520','1323401690805506048']){
  const detail=await replay.getReplay(id);let url=proxy.validateSourceUrl(detail.streamUrl);const scope=proxy.scopeFor(url);
  for(let depth=0;depth<4;depth++){
   const {response,finalUrl}=await proxy.upstreamRequest(url.href,{}, {scope});
   const chunks=[];for await(const chunk of response)chunks.push(chunk);
   const text=proxy.decodeManifest(Buffer.concat(chunks),response.headers['content-encoding']);
   if(text.includes('#EXT-X-STREAM-INF:')){const lines=text.split(/\r?\n/);const i=lines.findIndex(l=>l.startsWith('#EXT-X-STREAM-INF:'));url=proxy.validateSourceUrl(new URL(lines[i+1],finalUrl),scope);continue;}
   const p=media.mediaPlan(text,finalUrl,scope);
   console.log(JSON.stringify({liveId:id,seconds:p.seconds,segments:p.segments,discontinuities:(text.match(/#EXT-X-DISCONTINUITY\b/g)||[]).length}));break;
  }
 }
})().catch(e=>{console.log('FAIL',e.preset?e.message:e.code||e.name);process.exitCode=1});
NODE
