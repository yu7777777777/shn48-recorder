"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const exported=require("../modules/analysis/export");
const entry=(overrides={})=>({recordingId:"rec-1",title:"普通直播",analyzed:true,segments:2,english:{recorded:1,segments:2},stages:[
 {stage:"transcribe",status:"recorded",fingerprint:"fp",completedAt:"2026-01-01T00:00:00.000Z"},
 {stage:"correct",status:"recorded",model:"c",completedAt:"2026-01-01T01:00:00.000Z"},
 {stage:"translate",status:"partial",missing:["provider"]},
 {stage:"summarize",status:"absent",missing:["provider","model"]}
],...overrides});
test("csv provenance writes one header and one row per archive",()=>{
 const text=exported.csvProvenance([entry(),entry({recordingId:"rec-2",title:"第二条",analyzed:false,segments:undefined,english:undefined,stages:[]})]);
 const rows=text.split("\r\n").filter(Boolean);
 assert.equal(rows.length,3);
 assert.equal(rows[0],exported.CSV_COLUMNS.join(","));
 // Columns: 归档,标题,已分析,字幕条数,已翻译,已译日文,识别,纠错,翻译,日文翻译,总结
 assert.deepEqual(rows[1].split(",").slice(0,11),["rec-1","普通直播","是","2","1","","已记录","已记录","信息不全","缺少记录","缺少记录"],"no Japanese run leaves an empty cell, never a false 0");
 assert.deepEqual(rows[2].split(",").slice(0,6),["rec-2","第二条","否","","",""],"an unanalysed archive says so instead of looking empty");
 // A recorded Japanese run reports its own count and status.
 const jaRow=exported.csvProvenance([entry({japanese:{segments:2,recorded:2},stages:[{stage:'translate-ja',status:'recorded',completedAt:'2026-01-01T02:00:00.000Z'}]})]).split('\r\n')[1].split(',');
 assert.equal(jaRow[5],'2');assert.equal(jaRow[9],'已记录');
});
test("csv cells cannot smuggle a formula or split a row",()=>{
 const text=exported.csvProvenance([entry({title:"=HYPERLINK(\"http://evil\")",recordingId:"a,b"})]);
 const row=text.split("\r\n")[1];
 assert.ok(row.includes("'=HYPERLINK"),"a formula-looking title is neutralised");
 assert.ok(row.includes("\"a,b\""),"a comma inside a value is quoted");
 const quoted=exported.csvProvenance([entry({title:"他说\"你好\"\n然后走了"})]);
 assert.ok(quoted.includes("\"他说\"\"你好\"\"\n然后走了\""),"quotes are doubled and newlines stay inside one cell");
 assert.equal(quoted.split("\r\n").filter(Boolean).length,2,"a newline inside a cell does not create a row");
});
test("csv provenance never includes a URL, key or payload",()=>{
 const text=exported.csvProvenance([entry({summaryEndpoint:"https://ai.example.com/v1?key=sk-1",stages:[{stage:"summarize",status:"recorded",provider:"ai.example.com",model:"m",completedAt:"2026-01-01T00:00:00.000Z"}]})]);
 assert.equal(text.includes("sk-1"),false);assert.equal(text.includes("https://"),false);
 assert.equal(text.includes("ai.example.com"),false,"the CSV carries completion and status only");
 assert.equal(exported.csvProvenance([]).trim(),exported.CSV_COLUMNS.join(","),"an empty batch is still a valid single header row");
});
