"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const translation=require("../modules/analysis/translation");
const ai={url:"http://127.0.0.1:9999/v1",model:"fake-model"};
const id=translation.identity(ai);
const seg=(text,en)=>({start:0,end:1,text,...(en?translation.stamp({start:0,end:1,text},en,id):{})});
test("provenance separates recorded, partial and absent stages without leaking secrets",()=>{
 const data={recordingId:"r1",fingerprint:"123:456:asr:whisper-1:abc",correctedAt:"2026-01-01T00:00:00.000Z",correctionModel:"corr",correctionEndpoint:"http://127.0.0.1:9999/v1",summaryModel:"sum",summaryEndpoint:"http://127.0.0.1:9999/v1",summarizedAt:"2026-01-02T00:00:00.000Z",segments:[seg("甲","A"),seg("乙")],apiKey:"sk-secret",glossary:[{term:"甲"}]};
 const out=exported.provenance(data,"2026-01-03T00:00:00.000Z");
 const by=Object.fromEntries(out.stages.map(s=>[s.stage,s]));
 assert.equal(by.correct.status,"recorded");assert.equal(by.summarize.status,"recorded");assert.equal(by.transcribe.status,"partial");assert.deepEqual(by.transcribe.missing,["completedAt"],"fingerprint alone does not prove a finished transcription");
 assert.equal(out.exportedAt,"2026-01-03T00:00:00.000Z");assert.equal(out.segments,2);assert.equal(out.glossary,1);
 assert.equal(out.english.recorded,1);assert.equal(out.english.segments,2);
 const text=exported.renderProvenance(data);assert.equal(text.includes("sk-secret"),false,"secrets never reach the export");
 // The host names the provider; the path, port, query and any token must not.
 assert.equal(text.includes("/v1"),false,"URL paths are not exported");
 assert.equal(by.correct.provider,"127.0.0.1:9999");assert.equal(by.summarize.provider,"127.0.0.1:9999");
 assert.equal(by.translate.provider,"127.0.0.1:9999");
});
test("an absent stage reports every missing field instead of a bare null",()=>{
 const out=exported.provenance({segments:[],recordingId:"r2"},"2026-01-03T00:00:00.000Z");
 for(const stage of out.stages)assert.equal(stage.status,"absent");
 assert.deepEqual(out.stages.find(s=>s.stage==="summarize").missing,["provider","model","completedAt"],"a host label is still a required field");
 assert.equal(out.stages.find(s=>s.stage==="summarize").provider,null,"a missing endpoint is reported, not invented");
 assert.equal(out.stages.find(s=>s.stage==="correct").provider,null);
 assert.equal(out.english.segments,0);
 assert.equal(out.glossary,null);
});
test("translated count only counts rows that carry provenance",()=>{
 const out=exported.provenance({segments:[seg("甲","A"),{start:0,end:1,text:"乙",en:"B"}]});
 assert.equal(out.english.recorded,1,"legacy bare en is not provenance");
 const stage=out.stages.find(s=>s.stage==="translate");
 assert.equal(stage.status,"recorded");assert.equal(stage.model,"fake-model");
});
test("provider labels are hosts only, including opaque and malformed values",()=>{
 const out=exported.provenance({segments:[],summaryEndpoint:"https://ai.example.com/openai/v1?key=sk-123#frag",correctionEndpoint:"not-a-url-but-short",summarizedAt:"2026-01-01T00:00:00.000Z",correctionModel:"c",correctedAt:"2026-01-01T00:00:00.000Z"});
 const by=Object.fromEntries(out.stages.map(s=>[s.stage,s]));
 assert.equal(by.summarize.provider,"ai.example.com");
 assert.equal(by.correct.provider,"not-a-url-but-short");
 const text=exported.renderProvenance({segments:[],summaryEndpoint:"https://ai.example.com/openai/v1?key=sk-123#frag",summarizedAt:"2026-01-01T00:00:00.000Z",summaryModel:"m"});
 assert.equal(text.includes("sk-123"),false,"query strings never leak");
 assert.equal(text.includes("/openai/v1"),false,"paths never leak");
});
