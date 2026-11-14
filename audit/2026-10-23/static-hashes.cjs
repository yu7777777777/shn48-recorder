'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const base='http://<SERVER_IP>:3000';
const dist=path.resolve(__dirname,'../../app/client/dist');
const built=path.join(__dirname,'client-build');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
(async()=>{
 const files=walk(dist);const rows=[];
 for(const file of files){
  const rel=path.relative(dist,file).replaceAll('\\','/');
  const response=await fetch(base+'/'+rel,{signal:AbortSignal.timeout(15000)});
  const remote=Buffer.from(await response.arrayBuffer()),local=fs.readFileSync(file);
  const candidate=path.join(built,rel);
  rows.push({path:rel,httpStatus:response.status,localSha256:hash(local),remoteSha256:hash(remote),matches:response.ok&&hash(local)===hash(remote),matchesAuditBuild:fs.existsSync(candidate)&&hash(local)===hash(fs.readFileSync(candidate))});
 }
 const result={sampledAt:new Date().toISOString(),base,count:rows.length,remoteMatches:rows.filter(r=>r.matches).length,auditBuildMatches:rows.filter(r=>r.matchesAuditBuild).length,rows};
 fs.writeFileSync(path.join(__dirname,'static-hashes.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({sampledAt:result.sampledAt,count:result.count,remoteMatches:result.remoteMatches,auditBuildMatches:result.auditBuildMatches,mismatches:rows.filter(r=>!r.matches||!r.matchesAuditBuild)},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
Description: void 0;
