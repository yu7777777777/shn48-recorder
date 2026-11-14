"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const data=(segments)=>({summary:"概述",chapters:[{start:0,end:2,title:"开场",summary:"开场内容",evidenceIds:[0]}],highlights:[],segments});
test("a summary snapshot carries Japanese only when a row actually has it",()=>{
 const plain=exported.snapshot("r1",data([{start:0,end:2,text:"你好"}]));
 assert.equal(Object.hasOwn(plain.segments[0],"ja"),false,"archives without Japanese keep the old shape");
 assert.equal(plain.segments[0].en,"");
 const withJa=exported.snapshot("r1",data([{start:0,end:2,text:"你好",en:"Hello",enJA:"こんにちは"}]));
 assert.equal(withJa.segments[0].ja,"こんにちは");assert.equal(withJa.segments[0].en,"Hello");
 const blank=exported.snapshot("r1",data([{start:0,end:2,text:"你好",enJA:"   "}]));
 assert.equal(Object.hasOwn(blank.segments[0],"ja"),false,"a whitespace-only column is not a translation");
});
test("markdown quotes translations under the evidence line without breaking the quote",()=>{
 // render() returns {type, extension, text}; the assertions read the text.
 const text=exported.render("r1",data([{start:0,end:2,text:"你好 > 世界",en:"Hello *world*",enJA:"こんにちは"}])).text;
 assert.match(text,/> 字幕 1 · 00:00:00 — 00:00:02：你好 &gt; 世界/);
 // escape() writes a literal backslash before markdown punctuation; match it as-is.
 assert.ok(text.includes("> 英文：Hello \\*world\\*"),"translated text is escaped, not injected as markdown");
 assert.match(text,/> 日文：こんにちは/);
 const enOnly=exported.render("r1",data([{start:0,end:2,text:"你好",en:"Hello"}])).text;
 assert.equal(enOnly.includes("日文："),false,"no empty Japanese label");
});
test("the export never adds provenance or URLs to a segment row",()=>{
 const value=exported.snapshot("r1",data([{start:0,end:2,text:"你好",en:"Hello",enJA:"こんにちは",translation:{$v:"ja-v1",provider:"https://ai.example.com/v1?key=sk"},checkpoint:{secret:true}}]));
 assert.deepEqual(Object.keys(value.segments[0]).sort(),["en","end","id","ja","start","text"]);
 assert.equal(JSON.stringify(value).includes("sk"),false);assert.equal(JSON.stringify(value).includes("checkpoint"),false);
});
