set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const root='/app/recordings/.replay-diagnostics-20261102';
if(fs.realpathSync(root)!==root)throw Error('Unsafe diagnostic path');
for(const id of ['1323430498988265472','1323043490600128512']){
 const dir=path.join(root,id);if(fs.realpathSync(dir)!==dir)throw Error('Unsafe live path');
 const files=fs.readdirSync(dir).filter(n=>/^period-\d+\.(?:mp4|m3u8)$/.test(n)||['normalized.mp4','replay.processing.mp4','concat.txt'].includes(n));
 const evidence=[];
 for(const name of files){const file=path.join(dir,name);if(!fs.lstatSync(file).isFile())throw Error('Unsafe file');const bytes=fs.statSync(file).size;const hash=name.endsWith('.mp4')?execFileSync('sha256sum',[file],{encoding:'utf8'}).split(' ')[0]:null;evidence.push({name,bytes,sha256:hash});}
 fs.writeFileSync(dir+'/diagnostic-derived-files.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 for(const name of files)fs.unlinkSync(path.join(dir,name));
 console.log(JSON.stringify({id,removedDerivedFiles:files.length,bytes:evidence.reduce((s,f)=>s+f.bytes,0)}));
}
NODE
df -h /
