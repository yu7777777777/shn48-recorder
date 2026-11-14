'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'oss-sync-test-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const oss=require('../modules/analysis/oss-adapter'),sync=require('../modules/analysis/oss-sync');
// These literal fixtures are never taken from ALIYUN_* process variables.
const fixture={ALIYUN_ACCESS_KEY_ID:'offline-test-ak',ALIYUN_ACCESS_KEY_SECRET:'offline-test-sk-DO-NOT-LEAK',ALIYUN_OSS_BUCKET:'offline-media',ALIYUN_OSS_ENDPOINT:'https://offline-media.oss-cn-hangzhou.aliyuncs.com',ALIYUN_OSS_PREFIX:'offline clips'};
const fixedDate=new Date('2026-10-22T12:00:00.000Z'),source=Buffer.from('offline MP4 fixture; no media processing');
const file=path.join(process.env.RECORDINGS_DIR,'fixture.mp4');fs.writeFileSync(file,source);
const recording={id:'rec-test',status:'done',filePath:file};
const savedFetch=global.fetch;
function safe(error,code){assert.equal(error.code,code);for(const secret of [fixture.ALIYUN_ACCESS_KEY_ID,fixture.ALIYUN_ACCESS_KEY_SECRET,'Signature=','Authorization','PRIVATE-SIGNATURE'])assert.equal(String(error.stack).includes(secret),false);assert.equal(error.cause,undefined);return true;}
function client(transport,extra={}){return oss._internals.createClient({env:fixture,transport,now:()=>fixedDate,...extra});}
async function consume(body){const chunks=[];for await(const chunk of body)chunks.push(chunk);return Buffer.concat(chunks);}
function response(status,headers={}){return {status,headers:new Headers(headers),body:{async cancel(){}}};}
test.before(()=>{global.fetch=()=>{throw Error('Real network calls are forbidden in OSS tests');};});
test.beforeEach(()=>{sync._internals.setEnvironment({...fixture});sync._internals.setTimeoutMs(undefined);sync._internals.setTransport(async()=>{throw Error('test must inject transport');});fs.writeFileSync(file,source);});
test.after(()=>{global.fetch=savedFetch;sync._internals.setTransport(undefined);sync._internals.setEnvironment({});sync._internals.setTimeoutMs(undefined);fs.rmSync(root,{recursive:true,force:true});});
test('missing or invalid configuration skips synchronization without touching files or transport',async()=>{
 let calls=0;sync._internals.setTransport(async()=>{calls++;throw Error('must not run');});for(const env of [{},{ALIYUN_ACCESS_KEY_ID:'partial'}, {...fixture,ALIYUN_OSS_ENDPOINT:'https://wrong.example.invalid'}]){sync._internals.setEnvironment(env);assert.equal(sync.isEnabled(),false);assert.equal((await sync.uploadRecording(null)).skipped,true);assert.equal((await sync.deleteRecording(null)).skipped,true);}assert.equal(calls,0);
});
test('PUT streams media with exact URL, MD5, content type and independent V1 authorization',async()=>{
 let calls=0;const key=oss.objectKey(fixture.ALIYUN_OSS_PREFIX,'recordings','rec-test.mp4');const transport=async(url,options)=>{
  calls++;assert.equal(url,'https://offline-media.oss-cn-hangzhou.aliyuncs.com/offline%20clips/recordings/rec-test.mp4');assert.equal(options.method,'PUT');assert.equal(options.redirect,'manual');assert.equal(options.duplex,'half');assert.equal(options.headers['Content-Type'],'video/mp4');assert.equal(options.headers['Content-Length'],String(source.length));const md5=crypto.createHash('md5').update(source).digest('base64');assert.equal(options.headers['Content-MD5'],md5);const canonical=['PUT',md5,'video/mp4',options.headers.Date,'/offline-media/'+key].join('\n');const signature=crypto.createHmac('sha1',fixture.ALIYUN_ACCESS_KEY_SECRET).update(canonical).digest('base64');assert.equal(options.headers.Authorization,'OSS '+fixture.ALIYUN_ACCESS_KEY_ID+':'+signature);assert.equal(options.headers.Date,fixedDate.toUTCString());assert.deepEqual(await consume(options.body),source);return response(200);
 };const output=await client(transport).upload(file,key);assert.deepEqual(output,{uploaded:true,key});assert.equal(calls,1);
});
test('recording sync uses a fixed recordings/id.mp4 key and does not modify recording metadata',async()=>{
 const previous=JSON.stringify(recording);let method;sync._internals.setTransport(async(_url,options)=>{method=options.method;await consume(options.body);return response(200);});const result=await sync.uploadRecording(recording);assert.equal(result.uploaded,true);assert.equal(result.key,'offline clips/recordings/rec-test.mp4');assert.equal(method,'PUT');assert.equal(JSON.stringify(recording),previous);assert.equal(sync.status().lastErrorCode,null);
});
test('provider 5xx has a safe upload code and never reads or leaks response XML',async()=>{
 let reads=0;sync._internals.setTransport(async()=>({status:503,body:{async cancel(){}},async text(){reads++;return fixture.ALIYUN_ACCESS_KEY_ID+' '+fixture.ALIYUN_ACCESS_KEY_SECRET;}}));await assert.rejects(sync.uploadRecording(recording),e=>{safe(e,'oss_upload_failed');assert.equal(e.httpStatus,503);return true;});assert.equal(reads,0);assert.equal(sync.status().lastErrorCode,'oss_upload_failed');
});
test('transport and filesystem exceptions are replaced without keys, signatures, paths or causes',async()=>{
 const poisoned=fixture.ALIYUN_ACCESS_KEY_ID+' '+fixture.ALIYUN_ACCESS_KEY_SECRET+' PRIVATE-SIGNATURE https://example.invalid?Signature=x';await assert.rejects(client(async()=>{throw Error(poisoned);}).upload(file,'safe.mp4'),e=>safe(e,'oss_upload_failed'));await assert.rejects(client(async()=>response(200)).upload(path.join(root,'missing-private-file.mp4'),'safe.mp4'),e=>{safe(e,'oss_upload_failed');assert.equal(e.message.includes(root),false);return true;});
});
test('DELETE signs an empty MD5/type request and treats missing objects as idempotent success',async()=>{
 for(const status of [204,404]){let calls=0;sync._internals.setTransport(async(url,options)=>{calls++;assert.equal(options.method,'DELETE');assert.equal(options.body,undefined);assert.equal(options.redirect,'manual');assert.ok(url.endsWith('/offline%20clips/recordings/rec-test.mp4'));const canonical=['DELETE','','',options.headers.Date,'/offline-media/offline clips/recordings/rec-test.mp4'].join('\n');const signature=crypto.createHmac('sha1',fixture.ALIYUN_ACCESS_KEY_SECRET).update(canonical).digest('base64');assert.equal(options.headers.Authorization,'OSS '+fixture.ALIYUN_ACCESS_KEY_ID+':'+signature);return response(status);});const result=await sync.deleteRecording({id:'rec-test'});assert.equal(result.deleted,true);assert.equal(result.missing,status===404);assert.equal(calls,1);}
});
test('DELETE failures are safe oss_delete_failed and never delete local media',async()=>{
 sync._internals.setTransport(async()=>response(500));await assert.rejects(sync.deleteRecording(recording),e=>safe(e,'oss_delete_failed'));assert.equal(sync.status().lastErrorCode,'oss_delete_failed');assert.deepEqual(fs.readFileSync(file),source);await assert.rejects(client(async()=>{throw Error(fixture.ALIYUN_ACCESS_KEY_SECRET);}).remove('key'),e=>safe(e,'oss_delete_failed'));
});
test('HEAD returns safe metadata or exists:false on 404 without downloading content',async()=>{
 let bodyRead=false;const found=await client(async(_url,options)=>{assert.equal(options.method,'HEAD');assert.equal(options.body,undefined);assert.match(options.headers.Authorization,/^OSS offline-test-ak:/);return {...response(200,{'Content-Length':'456'}),text(){bodyRead=true;}};}).head('key');assert.deepEqual(found,{exists:true,key:'key',size:456});assert.equal(bodyRead,false);assert.deepEqual(await client(async()=>response(404)).head('key'),{exists:false,key:'key'});await assert.rejects(client(async()=>response(503)).head('key'),e=>safe(e,'oss_head_failed'));
});
test('redirects are never followed or retried, for PUT DELETE and HEAD',async()=>{
 for(const method of ['upload','remove','head']){let calls=0;const transport=async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');return response(307,{Location:'https://attacker.invalid'});};const run=method==='upload'?()=>client(transport).upload(file,'key'):()=>client(transport)[method]('key');await assert.rejects(run,e=>safe(e,method==='upload'?'oss_upload_failed':method==='remove'?'oss_delete_failed':'oss_head_failed'));assert.equal(calls,1);}
});
test('invalid signing configuration and traversal keys fail before any transport call',async()=>{
 let calls=0;const transport=async()=>{calls++;return response(200);};for(const key of ['../secret.mp4','a/../secret.mp4','a/./file.mp4','/absolute.mp4','bad%2Fkey'])await assert.rejects(client(transport).upload(file,key),e=>safe(e,'oss_sign_failed'));await assert.rejects(client(transport,{env:{...fixture,ALIYUN_ACCESS_KEY_ID:'bad\r\nheader'}}).remove('key'),e=>safe(e,'oss_sign_failed'));assert.equal(calls,0);
});
test('default 60s timeout aborts a stalled PUT even when fake transport ignores the signal',async()=>{
 let expire,signal,cleared=0,calls=0;const uploader=client(async(_url,options)=>{calls++;signal=options.signal;expire();return new Promise(()=>{});},{setTimer:(fn,ms)=>{assert.equal(ms,60000);expire=fn;return 123;},clearTimer:timer=>{assert.equal(timer,123);cleared++;}});await assert.rejects(uploader.upload(file,'key'),e=>{safe(e,'oss_upload_failed');assert.equal(e.statusCode,504);assert.match(e.message,/超时/);return true;});assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(cleared,1);
});
test('file mutation between checksum and upload is detected before sending a PUT',async()=>{
 let dates=0,calls=0;const uploader=client(async()=>{calls++;return response(200);},{now:()=>{if(++dates===2)fs.appendFileSync(file,'changed');return fixedDate;}});await assert.rejects(uploader.upload(file,'key'),e=>{safe(e,'oss_upload_failed');assert.match(e.message,/文件在上传期间被修改/);return true;});assert.equal(calls,0);
});
test('file changes during transport cannot be reported as a successful upload',async()=>{
 await assert.rejects(client(async(_url,options)=>{await consume(options.body);fs.appendFileSync(file,'changed');return response(200);}).upload(file,'key'),e=>{safe(e,'oss_upload_failed');assert.match(e.message,/文件在上传期间被修改/);return true;});
});
test('recording validation refuses traversal, unfinished media and paths outside the archive',async()=>{
 let calls=0;sync._internals.setTransport(async()=>{calls++;return response(200);});for(const item of [{...recording,id:'../escape'},{...recording,status:'recording'},{...recording,filePath:path.join(root,'outside.mp4')}]){if(item.filePath.endsWith('outside.mp4'))fs.writeFileSync(item.filePath,source);await assert.rejects(sync.uploadRecording(item),e=>{assert.ok(['oss_sign_failed','oss_upload_failed'].includes(e.code));assert.equal(e.message.includes(root),false);return true;});}assert.equal(calls,0);
});
test('safe status contains only config identifiers and last error code, never a complete endpoint URL',async()=>{
 const state=sync.status();assert.equal(sync.isEnabled(),true);assert.deepEqual(Object.keys(state).sort(),['bucket','enabled','endpointHost','lastErrorCode','prefix']);assert.equal(state.bucket,'offline-media');assert.equal(state.endpointHost,'offline-media.oss-cn-hangzhou.aliyuncs.com');assert.equal(state.prefix,'offline clips');const serialized=JSON.stringify(state);for(const secret of [fixture.ALIYUN_ACCESS_KEY_ID,fixture.ALIYUN_ACCESS_KEY_SECRET,'https://','Signature='])assert.equal(serialized.includes(secret),false);
});
test('read-only GET /oss/status returns safe state without invoking transport or uploading',async()=>{
 let calls=0;sync._internals.setTransport(async()=>{calls++;throw Error('status must not send a request');});const router=require('../routes/analysis');const body=await new Promise((resolve,reject)=>router.handle({method:'GET',url:'/oss/status',headers:{}},{json:resolve,setHeader(){},status(){return this;}},error=>reject(error||Error('route not found'))));assert.equal(body.success,true);assert.deepEqual(body.data,sync.status());assert.equal(calls,0);
});
