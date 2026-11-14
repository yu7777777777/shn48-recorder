const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'srt-import-'));process.env.DATA_DIR=path.join(root,'data');process.env.RECORDINGS_DIR=path.join(root,'recordings');fs.mkdirSync(process.env.RECORDINGS_DIR);
const {parse}=require('../modules/analysis/srt'),service=require('../modules/analysis/service'),manager=require('../modules/recorder/manager'),settings=require('../modules/analysis/settings'),store=require('../lib/store');
test.after(()=>{service.stop();fs.rmSync(root,{recursive:true,force:true});});
const srt='1\n00:00:00,100 --> 00:00:01,500\n你好\n第二行';
test('parses BOM CRLF multiline and rejects malformed, oversized and out-of-range subtitles',()=>{
 assert.deepEqual(parse('\ufeff'+srt.replace(/\n/g,'\r\n'),3),[{start:.1,end:1.5,text:'你好\n第二行'}]);
 for(const text of ['', 'not srt', srt.replace('01,500','99,500'),srt.replace('00,100','02,000'),srt+'\n\ninvalid','x'.repeat(1000001)])assert.throws(()=>parse(text,3));
});
test('imports without ASR credentials, protects existing analysis and backs up confirmed replacement',async()=>{
 const file=path.join(process.env.RECORDINGS_DIR,'audio.m4a');const gen=spawnSync(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440','-t','3','-c:a','aac',file]);assert.equal(gen.status,0);
 const r=manager.addRecording({status:'done',mediaType:'audio',filePath:file});
 let out=await service.importSrt(r.id,{text:srt});assert.equal(out.source,'srt');assert.equal(out.segments.length,1);assert.equal(out.job.kind,'import');
 const old={...store.load(`analysis_${r.id}`),summary:'old summary',chapters:[{start:0,end:1,title:'old'}]};settings.write(`analysis_${r.id}`,old);
 await assert.rejects(()=>service.importSrt(r.id,{text:srt}),/确认替换/);
 await assert.rejects(()=>service.importSrt(r.id,{text:'bad',replace:true}));assert.equal(service.result(r.id).summary,'old summary');
 out=await service.importSrt(r.id,{text:srt.replace('你好','替换字幕'),replace:true});assert.equal(out.segments[0].text,'替换字幕\n第二行');assert.deepEqual(out.chapters,[]);assert.equal(out.summary,undefined);assert.equal(store.load(`analysis_${r.id}_before_import`).summary,'old summary');
 assert.equal(settings.get().asr.key,'');assert.match(service.subtitle(out.segments),/替换字幕/);
});
