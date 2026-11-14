"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const ja={$v:"ja-v1",target:"ja",endpoint:"https://ai.example.com/v1",model:"ja-model",instruction:"i"};
const en={$v:"en-v1",target:"en",endpoint:"https://ai.example.com/v1",model:"en-model",instruction:"i"};
test("a Japanese run is reported on its own stage instead of being credited to English",()=>{
 const data={recordingId:"r1",segments:[{start:0,end:1,text:"甲",en:"A",enJA:"あ",translation:ja},{start:1,end:2,text:"乙",enJA:"い"}]};
 const out=exported.provenance(data,"2026-01-03T00:00:00.000Z");
 const by=Object.fromEntries(out.stages.map(s=>[s.stage,s]));
 assert.equal(by["translate-ja"].status,"recorded");assert.equal(by["translate-ja"].model,"ja-model");assert.equal(by["translate-ja"].translatedSegments,2);
 assert.equal(by.translate.status,"absent","no English row carries provenance, so English is not reported as done");
 assert.deepEqual(out.japanese,{segments:2,recorded:2});
 assert.deepEqual(out.english,{segments:2,recorded:0});
});
test("an English-only archive reports no Japanese block at all",()=>{
 const out=exported.provenance({recordingId:"r2",segments:[{start:0,end:1,text:"甲",en:"A",translation:en}]});
 assert.equal(out.japanese,null,"null means never translated into Japanese");
 assert.equal(out.stages.find(s=>s.stage==="translate-ja").status,"absent");
 assert.equal(out.stages.find(s=>s.stage==="translate").status,"recorded");
});
test("the Japanese stage keeps the same redaction as every other stage",()=>{
 const text=exported.renderProvenance({recordingId:"r3",segments:[{start:0,end:1,text:"甲",enJA:"あ",translation:ja}]});
 assert.equal(text.includes("/v1"),false);assert.equal(text.includes("https://"),false);
 const md=exported.renderProvenanceText({recordingId:"r3",segments:[{start:0,end:1,text:"甲",enJA:"あ",translation:ja}]});
 // escape() backslashes the dots and hyphen inside cells, so compare cells, not raw text.
 const row=md.split('\n').find(line=>line.startsWith('| 日文翻译 |'));
 assert.deepEqual(row.split(' | ').map(cell=>cell.replace(/^\| /,'').replace(/ \|$/,'').replace(/\\(.)/g,'$1')).slice(0,4),['日文翻译','已记录','ai.example.com','ja-model']);
 assert.match(md,/带日文翻译来源的字幕：1 \/ 1/);
});
