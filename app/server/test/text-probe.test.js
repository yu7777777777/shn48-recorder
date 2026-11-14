const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'text-probe-'));process.env.DATA_DIR=root;
const probe=require('../modules/analysis/text-probe'),settings=require('../modules/analysis/settings');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('text connection probe sends one chat request and distinguishes reply, empty, auth, quota and invalid responses',async()=>{
 let code=200,body={choices:[{message:{content:'连接正常'}}]},calls=0,request;
 const server=http.createServer((req,res)=>{calls++;const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{request={url:req.url,auth:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))};res.writeHead(code,{'Content-Type':'application/json'});res.end(typeof body==='string'?body:JSON.stringify(body));});});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url=`http://127.0.0.1:${server.address().port}/v1`;settings.save({ai:{url,key:'text-secret',model:'saved-model'}});
  const before=JSON.stringify(settings.get());
  const result=await probe.test({model:'draft-model'});assert.equal(result.status,'connected');assert.equal(result.text,'连接正常');assert.equal(calls,1);assert.equal(request.url,'/v1/chat/completions');assert.equal(request.auth,'Bearer text-secret');assert.equal(request.body.model,'draft-model');assert.equal(request.body.stream,false);assert.equal(request.body.messages.length,1);assert.equal(JSON.stringify(settings.get()),before);
  body={choices:[{message:{content:''}}]};assert.equal((await probe.test({})).status,'empty');
  code=401;body={error:'text-secret'};const denied=await probe.test({});assert.equal(denied.httpStatus,401);assert.ok(!JSON.stringify(denied).includes('text-secret'));
  code=429;assert.equal((await probe.test({})).httpStatus,429);
  code=200;body='not json';assert.equal((await probe.test({})).status,'invalid_response');
  body={choices:[{message:{content:'text-secret'}}]};assert.equal((await probe.test({})).text,'[已隐藏]');
  await assert.rejects(()=>probe.test({url:'http://different.test/v1'}),/密钥/);assert.equal(calls,6);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
