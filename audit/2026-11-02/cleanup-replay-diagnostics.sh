set -euo pipefail
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path');const media=require('/app/server/modules/recorder/replay-download');let removed=0;
for(const root of ['/app/recordings/.replay-diagnostics-20261102','/app/data/.replay-diagnostics-20261102','/app/data/.legacy-rebuild-20261102']){
 if(!fs.existsSync(root))continue;if(fs.realpathSync(root)!==root)throw Error('Unexpected diagnostic path');
 for(const name of fs.readdirSync(root)){
  if(!/^\d{1,30}$/.test(name))continue;const dir=path.join(root,name);if(fs.realpathSync(dir)!==dir)throw Error('Unexpected diagnostic live path');
  removed+=media.cleanupTransient(dir);
  const complete=path.join(dir,'complete.json');if(!fs.existsSync(path.join(dir,'verified.mp4'))&&fs.existsSync(complete)){fs.unlinkSync(complete);removed++;}
 }
}
const script='/app/data/.legacy-replay-download.js';if(fs.existsSync(script)){fs.unlinkSync(script);removed++;}
console.log(JSON.stringify({diagnosticTransientFilesRemoved:removed,verifiedArchivesRemoved:0}));
NODE
df -h /
