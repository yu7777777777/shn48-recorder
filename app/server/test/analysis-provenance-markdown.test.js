"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const data={recordingId:"r1",segments:[{start:0,end:1,text:"a",en:"A"},{start:1,end:2,text:"b"}],summaryModel:"sum",summaryEndpoint:"https://ai.example.com/v1?key=sk-9",summarizedAt:"2026-01-01T00:00:00.000Z",correctionModel:"corr",correctionEndpoint:"https://corr.example.com/x",correctedAt:"2026-01-01T01:00:00.000Z",fingerprint:"abc123def456ghi"};
test("markdown provenance is readable, escapes text and never carries a URL",()=>{
 const text=exported.renderProvenanceText(data,"2026-01-03T00:00:00.000Z");
 // escape() backslashes markdown punctuation; undo it to read the cell values.
 const cells=(label)=>{const row=text.split("\n").find(line=>line.startsWith("| "+label+" |"));return row.split(" | ").map(value=>value.replace(/^\| /,"").replace(/ \|$/,"").replace(/\\(.)/g,"$1"));};
 assert.match(text,/^# 分析来源清单/m);
 assert.deepEqual(cells("总结").slice(0,4),["总结","已记录","ai.example.com","sum"]);
 assert.deepEqual(cells("纠错").slice(0,4),["纠错","已记录","corr.example.com","corr"]);
 assert.match(cells("语音识别")[3],/未记录模型（指纹 abc123def456）/,"a fingerprint without a model is labelled, not blank");
 assert.equal(cells("英文翻译")[1],"缺少记录");
 assert.equal(text.includes("sk-9"),false);assert.equal(text.includes("/v1"),false);assert.equal(text.includes("https://"),false,"no full URLs in the readable export");
});
test("markdown provenance escapes pipe characters so the table cannot be broken",()=>{
 const text=exported.renderProvenanceText({recordingId:"r|2",segments:[],summaryModel:"a|b",summaryEndpoint:"https://ai.example.com",summarizedAt:"2026-01-01T00:00:00.000Z"},"2026-01-03T00:00:00.000Z");
 const row=text.split("\n").find(line=>line.startsWith("| 总结"));
 // An unescaped pipe would split the row into an extra cell.
 assert.equal(row.split(" | ").length,6,"six cells stay intact");
 assert.match(row,/a\\\|b/);
});
test("markdown provenance refuses nothing but reports an empty record honestly",()=>{
 const text=exported.renderProvenanceText({segments:[]});
 assert.match(text,/字幕条数：0/);
 assert.equal((text.match(/缺少记录/g)||[]).length,5,"four pipeline stages plus the optional Japanese stage, all absent and never guessed");
 assert.match(text,/\| 日文翻译 \| 缺少记录 \|/,"the Japanese stage has its own row");
});
