"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48tools-ja-"));
process.env.DATA_DIR=path.join(root,"data");process.env.RECORDINGS_DIR=path.join(root,"recordings");fs.mkdirSync(process.env.RECORDINGS_DIR,{recursive:true});
const manager=require("../modules/recorder/manager"),service=require("../modules/analysis/service"),store=require("../lib/store");
test.after(()=>{service.stop();fs.rmSync(root,{recursive:true,force:true});});
function archived(){const file=path.join(process.env.RECORDINGS_DIR,`r${Math.random().toString(16).slice(2)}.m4a`);fs.writeFileSync(file,"x");return manager.addRecording({status:"done",filePath:file,mediaType:"audio"});}
function seed(id){store.atomicWrite(store.filePath(`analysis_${id}`),{segments:[{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"},{start:1.5,end:3,text:"再见",en:"Bye"}],chapters:[],highlights:[]});}
test("Japanese subtitles come from their own column and fall back per line",()=>{
 const rows=[{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"},{start:1.5,end:3,text:"再见",en:"Bye"}];
 const text=service.subtitle(rows,"ja");
 assert.match(text,/こんにちは/);
 assert.match(text,/再见/,"a segment without a Japanese line falls back to the original instead of going blank");
 assert.equal(text.includes("Bye"),false,"the English line must not leak into the Japanese track");
 // The existing bilingual track keeps pairing the original with English.
 assert.match(service.subtitle([{start:0,end:1.5,text:"你好",en:"Hello"}],"bilingual"),/你好\nHello/);
 assert.match(service.subtitle([{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"}],"bilingual"),/你好\nHello/,"Japanese presence must not silently change the English bilingual track");
 // A Japanese bilingual track is its own explicit mode.
 assert.match(service.subtitle([{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"}],"ja-bilingual"),/你好\nこんにちは/);
 assert.equal(service.subtitle([{start:0,end:1.5,text:"你好"}],"ja-bilingual").includes("你好\n\n"),false,"bilingual never emits an empty second line");
 assert.match(service.subtitle([{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"}],"en"),/Hello/);
 assert.equal(service.subtitle([{start:0,end:1.5,text:"你好",en:"Hello",enJA:"こんにちは"}],"en").includes("こんにちは"),false);
});
test("editing a segment drops the Japanese translation as well as the English one",async()=>{
 const rec=archived();seed(rec.id);
 service.editSegment(rec.id,0,"你好呀");
 const saved=store.load(`analysis_${rec.id}`,{segments:[]}).segments[0];
 assert.equal(saved.text,"你好呀");
 assert.equal(saved.en,undefined);assert.equal(saved.enJA,undefined,"a stale Japanese line must not survive an edit");
 assert.equal(saved.translation,undefined);assert.equal(saved.enSource,undefined);
 assert.equal(saved.originalText,"你好");
});
