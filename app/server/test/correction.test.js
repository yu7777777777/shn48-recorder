const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'correction-'));
process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const service=require('../modules/analysis/service'),settings=require('../modules/analysis/settings'),manager=require('../modules/recorder/manager'),store=require('../lib/store'),{validate}=require('../modules/analysis/correction');
const originalFetch=global.fetch;
test.after(()=>{service.stop();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
test('correction preserves timing and first original across repeated corrections; rejects omissions and duplicate IDs',()=>{
 const batch=[{start:1.2,end:3.4,text:'时别',en:'old'}];
 const out=validate([{id:5,text:'识别'}],batch,5);
 assert.deepEqual(out,[{start:1.2,end:3.4,text:'识别',originalText:'时别',en:undefined,enJA:undefined,enSource:undefined,translation:undefined}]);
 assert.equal(validate([{id:5,text:'识别。'}],out,5)[0].originalText,'时别');assert.equal(batch[0].text,'时别');
 for(const rows of [[],[{id:0,text:'x'}],[{id:5,text:''}],null])assert.throws(()=>validate(rows,batch,5));
 assert.throws(()=>validate([{id:0,text:'a'},{id:0,text:'b'}],[...batch,...batch],0));
 // 英文、日文及翻译来源记录都描述纠错前的原文，纠错后必须全部清空。
 const translated={start:5,end:6,text:'旧文',en:'old en',enJA:'ふるいぶん',enSource:'ja-model',translation:{target:'en',model:'m',endpoint:'https://ai.test/v1'}};
 const stripped=validate([{id:0,text:'新文'}],[translated],0)[0];
 for(const column of ['en','enJA','enSource','translation'])assert.equal(stripped[column],undefined,column+' 必须随纠错清空');
 assert.equal(stripped.originalText,'旧文');
 assert.deepEqual(JSON.parse(JSON.stringify(stripped)),{start:5,end:6,text:'新文',originalText:'旧文'},'落盘后翻译列不得残留');
});
async function settled(id){const end=Date.now()+5000;while(service.busy(id)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}return service.result(id);}
test('multi-batch failure leaves subtitles untouched; successful correction backs up, invalidates derived content and restores original',async()=>{
 const file=path.join(process.env.RECORDINGS_DIR,'test.mp4');fs.writeFileSync(file,'placeholder');
 const r=manager.addRecording({status:'done',filePath:file});
 const original={segments:Array.from({length:41},(_,i)=>({start:i,end:i+1,text:'原句'+i,en:'old',enJA:'舊'+i,enSource:'m',translation:{target:'en',model:'m'}})),summary:'old',chapters:[{title:'old'}],highlights:[]};
 settings.write(`analysis_${r.id}`,original);settings.save({ai:{url:'https://example.test/v1',key:'test-secret',model:'test'},glossary:[{term:'徐佳琳',aliases:'徐嘉林',enabled:true}]});
 settings.write(`voice_messages_${r.id}`,[{offset:12.3,senderName:'观众甲',bodys:'徐佳琳来了'}]);
 let count=0;
 const response=options=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);assert.equal(input.glossary[0].term,'徐佳琳');assert.deepEqual(input.danmaku,['[12.3s] 观众甲: 徐佳琳来了']);return Response.json({choices:[{message:{content:JSON.stringify({corrections:input.segments.map(s=>({id:s.id,text:'纠正'+s.id}))})}}]});};
 global.fetch=async(_url,options)=>++count===2?new Response('',{status:500}):response(options);
 service.start();service.enqueue(r.id,'correct');let out=await settled(r.id);assert.equal(out.job.status,'failed');assert.deepEqual(store.load(`analysis_${r.id}`),original);
 global.fetch=async(_url,options)=>response(options);service.enqueue(r.id,'correct');assert.throws(()=>service.restoreOriginal(r.id),/等待/);out=await settled(r.id);
 assert.equal(out.job.status,'done',out.job.error);assert.deepEqual(store.load(`analysis_${r.id}_before_correction`),original);assert.equal(out.segments[40].start,40);assert.equal(out.segments[40].originalText,'原句40');assert.equal(out.segments[40].en,undefined);assert.equal(out.segments[40].enJA,undefined);assert.equal(out.segments[40].enSource,undefined);assert.equal(out.segments[40].translation,undefined);assert.deepEqual(out.chapters,[]);
 out=service.restoreOriginal(r.id);assert.equal(out.segments[40].text,'原句40');assert.equal(out.segments[40].originalText,undefined);assert.equal(store.load(`analysis_${r.id}_before_restore`).segments[40].text,'纠正40');
});
test('manual correction preserves the first original and invalidates derived analysis',()=>{
 const file=path.join(process.env.RECORDINGS_DIR,'manual.mp4');fs.writeFileSync(file,'placeholder');
 const r=manager.addRecording({status:'done',filePath:file});
 settings.write(`analysis_${r.id}`,{segments:[{start:1,end:2,text:'原始句',en:'old'}],summary:'old',chapters:[{title:'old'}],highlights:[{title:'old'}]});
 let out=service.editSegment(r.id,0,'手动修正句');
 assert.equal(out.segments[0].text,'手动修正句');assert.equal(out.segments[0].originalText,'原始句');assert.equal(out.segments[0].en,undefined);assert.equal(out.summary,undefined);assert.deepEqual(out.chapters,[]);assert.deepEqual(out.highlights,[]);
 assert.throws(()=>service.editSegment(r.id,0,''),/不能为空/);
 // textarea 与 SRT 导入都允许多行：换行必须保留，其它控制字符仍压成空格，空行剔除。
 out=service.editSegment(r.id,0,'第一行\n  第二行 ');
 assert.equal(out.segments[0].text,'第一行\n第二行');
 out=service.editSegment(r.id,0,'第一行\r\n第二行\u0000第三行');
 assert.equal(out.segments[0].text,'第一行\n第二行 第三行');
 out=service.editSegment(r.id,0,'  a  \n\n  b  ');
 assert.equal(out.segments[0].text,'a\nb');
 assert.ok(service.subtitle(out.segments).includes('a\nb'),'SRT 导出保留多行 cue');
});
