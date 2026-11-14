"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'export-profiles-'));
process.env.DATA_DIR=root;
const {resolve}=require('../modules/analysis/export-profiles');
const expected={
 landscape:{profile:'landscape',width:1920,height:1080,videoBitrate:'8M',audioBitrate:'192k',container:'mp4'},
 portrait:{profile:'portrait',width:1080,height:1920,videoBitrate:'8M',audioBitrate:'192k',container:'mp4'},
 audio:{profile:'audio',width:null,height:null,videoBitrate:null,audioBitrate:'192k',container:'m4a'}
};
for(const profile of Object.keys(expected))test(profile+' resolves an isolated recommendation',()=>{
 assert.deepEqual(resolve(profile),expected[profile]);const changed=resolve(profile);changed.width=1;assert.deepEqual(resolve(profile),expected[profile]);
});
test('omission means no override and invalid profile is a clear 400 error',()=>{
 assert.equal(resolve(),null);
 for(const value of ['',null,{},[],42,'Landscape','landscape ','../audio','toString','__proto__'])assert.throws(()=>resolve(value),error=>error.statusCode===400 && /导出档位无效/.test(error.message));
});
test('summary and subtitle exports preserve defaults; optional profiles are metadata only',async()=>{
 const express=require('express'),service=require('../modules/analysis/service'),exporter=require('../modules/analysis/export');
 const original=service.result;
 const fixture={summary:'概述',segments:[{start:0,end:2,text:'字幕',en:'Caption'}],chapters:[{start:0,end:2,title:'章节',summary:'内容',evidenceIds:[0]}],highlights:[]};
 service.result=()=>fixture;
 const app=express();app.use('/analysis',require('../routes/analysis'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port+'/analysis/record/';
 try{
  for(const [route,body] of [['summary?format=json',exporter.render('record',fixture,'json').text],['subtitles?language=bilingual',service.subtitle(fixture.segments,'bilingual')]]){
   const baseline=await fetch(base+route);assert.equal(baseline.status,200);const expectedBody=await baseline.text();assert.equal(expectedBody,body);
   for(const key of ['x-export-profile','x-export-parameters','x-export-encoding'])assert.equal(baseline.headers.get(key),null,'omission must not add '+key);
   for(const profile of Object.keys(expected)){
    const response=await fetch(base+route+'&profile='+profile);assert.equal(response.status,200);assert.equal(response.headers.get('x-export-profile'),profile);assert.equal(response.headers.get('x-export-encoding'),'unchanged');assert.deepEqual(JSON.parse(response.headers.get('x-export-parameters')),expected[profile]);
    assert.equal(await response.text(),expectedBody,'profile must not change the existing text body');
    for(const header of ['content-type','content-disposition'])assert.equal(response.headers.get(header),baseline.headers.get(header));
   }
   for(const query of ['&profile=','&profile=other','&profile=landscape&profile=audio','&profile[x]=audio']){
    const response=await fetch(base+route+query);assert.equal(response.status,400);assert.match((await response.json()).error,/导出档位无效/);
   }
  }
 }finally{service.result=original;await service.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
