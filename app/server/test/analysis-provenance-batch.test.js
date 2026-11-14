"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const record=(id,extra={})=>({recordingId:id,segments:[{start:0,end:1,text:"甲"}],summaryModel:"m",summaryEndpoint:"https://ai.example.com/v1?key=sk-1",summarizedAt:"2026-01-01T00:00:00.000Z",...extra});
test("batch provenance aggregates per-recording records under the same redaction rules",()=>{
 const out=JSON.parse(exported.batchProvenance([record("a"),record("b")],"2026-01-03T00:00:00.000Z"));
 assert.equal(out.schemaVersion,1);assert.equal(out.exportedAt,"2026-01-03T00:00:00.000Z");assert.equal(out.count,2);
 assert.deepEqual(out.recordings.map(r=>r.recordingId),["a","b"]);
 for(const entry of out.recordings){const sum=entry.provenance.stages.find(s=>s.stage==="summarize");assert.equal(sum.provider,"ai.example.com");assert.equal(sum.status,"recorded");}
 const text=exported.batchProvenance([record("a")]);
 assert.equal(text.includes("sk-1"),false,"query strings never reach the batch export");
 assert.equal(text.includes("/v1"),false,"paths never reach the batch export");
});
test("batch provenance de-duplicates ids and refuses empty or oversized requests",()=>{
 const out=JSON.parse(exported.batchProvenance([record("a"),record("a"),record("b")],now=>""));
 assert.equal(out.count,2,"the same archive is audited once");
 assert.throws(()=>exported.batchProvenance([]),/请提供要导出的归档列表/);
 assert.throws(()=>exported.batchProvenance(null),/请提供要导出的归档列表/);
 const many=Array.from({length:51},(_,i)=>record("r"+i));
 assert.throws(()=>exported.batchProvenance(many),/一次最多导出 50 条/);
 assert.equal(JSON.parse(exported.batchProvenance(many.slice(0,50))).count,50,"exactly 50 is allowed");
});
test("an unreadable archive becomes an entry error instead of vanishing",()=>{
 const out=JSON.parse(exported.batchProvenance([record("a"),null,{}]));
 assert.equal(out.recordings.length,3,"nothing is silently dropped");
 assert.match(out.recordings[1].error,/无法读取/);assert.match(out.recordings[2].error,/无法识别归档编号/);
 assert.equal(out.recordings[0].provenance.recordingId,"a");
});
