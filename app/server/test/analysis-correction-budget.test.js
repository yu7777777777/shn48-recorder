"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {BUDGET,budgeted,validate}=require('../modules/analysis/correction');
const row=(id,text="字幕")=>{return {id,text};};
test("correction budget rejects work that exceeds the declared per-request caps",async()=>{
 const many=Array.from({length:BUDGET.maxSegments+1},(_,i)=>row(i));
 await assert.rejects(()=>budgeted(many,{}),/单次纠错最多 40 条/);
 await assert.rejects(()=>budgeted([row(0,"x".repeat(BUDGET.maxSegmentChars+1))],{}),/单条字幕超出/);
 await assert.rejects(()=>budgeted([row(0)],{glossary:[{term:"词".repeat(BUDGET.maxGlossary)}]}),/词库参考超过/);
 await assert.rejects(()=>budgeted([row(0)],{danmaku:Array.from({length:BUDGET.maxDanmaku+1},()=>"x")}),/弹幕参考/);
});
test("correction budget reports the actual payload size and keeps existing danmaku windows",async()=>{
 const usage=await budgeted([row(0,"一二三"),row(1,"四")],{danmaku:["a","b"],glossary:[{term:"甲",enabled:true},{term:"乙",enabled:false}]});
 assert.equal(usage.segments,2);assert.equal(usage.chars,4);assert.equal(usage.danmaku,2);assert.equal(usage.glossary,1);assert.equal(usage.windowMs,0);assert.equal(BUDGET.windowMs,0);
 const empty=await budgeted(null,{});assert.equal(empty.segments,0);
});
test("validated corrections cannot be truncated by the transport budget",async()=>{
 const batch=[row(0,"原句"),row(1,"第二句")];
 const out=validate([{id:0,text:"修正一"},{id:1,text:"修正二"}],batch,0);
 assert.deepEqual(out.map(s=>s.text),["修正一","修正二"]);
 assert.throws(()=>validate([{id:0,text:"只有一条"}],batch,0),/条数不匹配/);
});

test('batch larger than the built-in segment budget is accepted when the caller raises the limit',async()=>{
 // 线上把 CORRECTION_BATCH_SIZE 配成 2000，而内置预算是 40：若调用方不放开分段数，
 // 每一批都会抛「单次纠错最多 40 条」，纠错功能整体不可用。
 const many=Array.from({length:2000},(_,i)=>row(i));
 await assert.rejects(()=>budgeted(many,{}),/单次纠错最多 40 条/);
 const usage=await budgeted(many,{},{...BUDGET,maxSegments:2000});
 assert.equal(usage.segments,2000);
 assert.equal(usage.maxSegments,2000);
});
