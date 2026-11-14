import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = process.cwd();
const audit = path.join(root, 'audit/2026-10-30/release-1.31.2');
const before = JSON.parse(fs.readFileSync(path.join(audit,'manifests-before.json'),'utf8'));
function strip(data) { data = structuredClone(data); delete data.version; if(data.packages?.['']) delete data.packages[''].version; if(data.description) data.description=data.description.replaceAll(/1\.31\.[12]/g,'<release>'); return data; }
for(const [file, data] of Object.entries(before)) { const now=JSON.parse(fs.readFileSync(path.join(root,'app',file),'utf8')); assert.equal(now.version,'1.31.2'); if(now.packages?.['']) assert.equal(now.packages[''].version,'1.31.2'); if(file.endsWith('package.json')) { assert.deepEqual(strip(now),strip(data)); console.log('PASS package metadata-only '+file); } else { console.log('PASS root version '+file+' '+data.version+' -> '+now.version+'; full dependency comparison unavailable: pre-set read snapshot truncated'); } }
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const files=[path.join(root,'app/VERSION'),...walk(path.join(root,'app/client/dist'))].sort();
const sums=files.map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+path.relative(root,file).replaceAll('\\','/')).join('\n')+'\n';
fs.writeFileSync(path.join(audit,'frontend-VERSION.SHA256SUMS'),sums);
console.log('PASS SHA-256 manifest '+files.length+' frontend/VERSION files');
