'use strict';
const fs=require('fs'),{spawnSync}=require('child_process');
const root='/app/data/recovery-20261026-29';
const ids=['1321554233301733376','1321966661005021184','1322332610476445696'];
const free=()=>{const s=fs.statfsSync(root);return s.bavail*s.bsize;};
const protect=root+'/unfinished';
const isProtected=f=>f.startsWith(protect+'/');
function protectedSpace(){try{return fs.readdirSync(protect).map(d=>{const dir=protect+'/'+d;return fs.readdirSync(dir).filter(f=>/^asset-\d{5}/.test(f)).reduce((s,f)=>{try{return s+fs.statSync(dir+'/'+f).size;}catch{return s;}},0);}).reduce((a,b)=>a+b,0);}catch{return 0;}}
console.log(JSON.stringify({event:'inspect',freeGiB:free()/2**30,protectedBytes:protectedSpace(),dirs:ids.map(id=>{const dir=root+'/'+id;let names=[];try{names=fs.readdirSync(dir);}catch{}const plan=(()=>{try{return JSON.parse(fs.readFileSync(dir+'/plan.json','utf8'));}catch{return null;}})();return{liveId:id,files:names.reduce((o,n)=>{try{o[n]=fs.statSync(dir+'/'+n).size;}catch{}return o;},{}),segments:plan?Object.keys(plan.completed||{}).length:null,total:plan?.resources?.length??null,hasComplete:names.includes('complete.json'),hasVerified:names.includes('verified.mp4')};})}));
