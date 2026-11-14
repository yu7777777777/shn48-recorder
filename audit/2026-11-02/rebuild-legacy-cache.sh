set -euo pipefail
REL=/opt/shn48/releases/1.32.3
docker run --rm --network none --entrypoint cat shn48-shn48:1.32.1 /app/server/modules/recorder/replay-download.js > "$REL/legacy-replay-download.js"
docker cp "$REL/legacy-replay-download.js" shn48-recorder:/app/data/.legacy-replay-download.js
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path'),Module=require('module');
const filename='/app/server/modules/recorder/replay-download.js';
const legacy=new Module(filename,module);legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));legacy._compile(fs.readFileSync('/app/data/.legacy-replay-download.js','utf8'),filename);
(async()=>{
 const liveId='1323401690805506048',directory='/app/data/.legacy-rebuild-20261102/'+liveId;
 const r=await legacy.exports.download({liveId,directory,verify:false});
 const expected='8fd971e6fc08848ffd7e54b4d5f5798259636c426c8397bd05a90db0f48e8344';
 if(r.sha256!==expected)throw Error('Original hash was not reproduced');
 console.log(JSON.stringify({liveId,sha256:r.sha256,durationSeconds:r.durationSeconds,originalHashReproduced:true}));
})().catch(e=>{console.error(e.preset?e.message:e.message==='Original hash was not reproduced'?e.message:'Legacy reconstruction failed');process.exitCode=1});
NODE

