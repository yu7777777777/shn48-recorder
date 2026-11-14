"use strict";
const test=require('node:test'), assert=require('node:assert/strict'), express=require('express'), fs=require('fs'),os=require('os'),path=require('path');
test('backup endpoints are admin-only and do not fall through to the SPA',async()=>{
 const {createApp}=require('../index');const app=createApp();const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const origin='http://127.0.0.1:'+server.address().port;for(const route of ['/api/admin/backup115','/api/admin/backup115/auth/qr/test']){const res=await fetch(origin+route);assert.equal(res.status,401);assert.equal((await res.json()).success,false);}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('QR tokens stay private, are bound to a session, and settings reject secret fields',async()=>{
 const module=require('../modules/backup115/service'), original=module.service;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'backup115-api-'));let polls=0;
 const provider={invoke:async command=>{
  if(command==='qr_start')return{token:{uid:'PRIVATE_UID',time:1,sign:'PRIVATE_SIGN'},qrUrl:'https://115.com/scan/dg-test',expiresIn:120};
  if(command==='qr_poll'){polls++;return{status:'signed_in',connection:{runtimeAvailable:true,authorized:true,accountId:'100',accountLabel:'115 ***0100'}};}
  return{runtimeAvailable:true,authorized:false};
 }};
 const service=module.createService({root,dir:path.join(root,'state'),provider,manager:{getRecordings:()=>[],getRecording:()=>null},stable:()=>{}});
 module.service=()=>service;delete require.cache[require.resolve('../routes/backup115')];const router=require('../routes/backup115');module.service=original;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.adminSession={username:'test'};next();});app.use('/api/admin/backup115',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/admin/backup115';
 const request=async(url,method='GET',body,cookie='test-session-a')=>fetch(base+url,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const res=await request('/auth/qr','POST',{});const data=(await res.json()).data;assert.ok(data.qrDataUrl.startsWith('data:image/png;base64,'));assert.ok(data.sessionId);assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
  assert.equal((await request('/auth/qr/'+data.sessionId,'GET',undefined,'test-session-b')).status,404);
  const signed=(await(await request('/auth/qr/'+data.sessionId)).json()).data;assert.equal(signed.status,'signed_in');assert.equal(signed.connection.authorized,true);assert.ok(!JSON.stringify(signed).includes('accountId'));
  await request('/auth/qr/'+data.sessionId);assert.equal(polls,1);
  assert.equal((await request('/settings','PUT',{cookie:'never-save'})).status,400);
  const cross=await fetch(base+'/settings',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:JSON.stringify({autoBackup:true})});assert.equal(cross.status,403);
  const read=(await(await request('')).json()).data;assert.ok(!JSON.stringify(read).includes('PRIVATE_'));assert.equal(read.settings.autoBackup,false);
 }finally{await service.stop();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});module.service=original;delete require.cache[require.resolve('../routes/backup115')];}
});
