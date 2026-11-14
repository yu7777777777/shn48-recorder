const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'asr-probe-'));process.env.DATA_DIR=root;
const probe=require('../modules/analysis/probe'),settings=require('../modules/analysis/settings');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('classifies text-only, empty and valid timestamps without claiming recognition accuracy',()=>{
 assert.equal(probe.classify({text:'你好'}).status,'text_only');
 assert.equal(probe.classify({}).status,'empty');
 assert.equal(probe.classify({segments:[{text:'你好',start:0,end:2}]}).status,'compatible');
 assert.equal(probe.classify({segments:[{text:'你好',start:0,end:999}]}).status,'text_only');
});
test('sends one fixed audio request, uses saved key, keeps settings and reports failures',async()=>{
 let code=200,body={segments:[{start:0,end:2,text:'你好'}]},calls=0,request;
 const server=http.createServer((req,res)=>{calls++;const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{request={url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks)};res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));});});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/v1`;settings.save({asr:{url,key:'probe-secret',model:'test-model'}});
  const before=JSON.stringify(settings.get());
  const result=await probe.test({});assert.equal(result.status,'compatible');assert.equal(calls,1);assert.equal(request.url,'/v1/audio/transcriptions');assert.equal(request.auth,'Bearer probe-secret');
  assert.ok(request.body.includes(Buffer.from('RIFF')));assert.ok(request.body.includes(Buffer.from('verbose_json')));assert.equal(JSON.stringify(settings.get()),before);
  code=401;body={error:'probe-secret'};const denied=await probe.test({});assert.equal(denied.httpStatus,401);assert.ok(!JSON.stringify(denied).includes('probe-secret'));assert.equal(calls,2);
  code=200;body={text:'probe-secret'};assert.ok(!JSON.stringify(await probe.test({})).includes('probe-secret'));
  await assert.rejects(()=>probe.test({url:'http://different.test/v1'}),/密钥/);assert.equal(calls,3);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
