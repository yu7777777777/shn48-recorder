"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const replay=require("../modules/pocket48/replay");
const raw=(extra={})=>({liveId:"487000",playStreamPath:"https://idol-vod.48.cn/x.m3u8",userInfo:{userId:"1",nickname:"A"},...extra});
test("the review gate stays an internal rule, never a field on the public replay DTO",()=>{
  // Whatever Pocket48 sends, the public shape must not echo the gating inputs back.
  for(const value of [false,true,"true",1,"1",undefined]){
    const dto=replay.publicReplay(raw({review:value}));
    assert.equal(Object.hasOwn(dto,"review"),false,"review must not be published for "+String(value));
    assert.equal(Object.hasOwn(dto,"streamPath"),false,"the stream path is resolved separately, not echoed");
  }
  assert.deepEqual(Object.keys(replay.publicReplay(raw())).sort(),["cover","duration","durationSeconds","liveId","liveMode","liveType","member","startedAt","status","team","title"]);
});
test("the DTO keeps normalized public fields and drops private recording data",()=>{
  const dto=replay.publicReplay({...raw(),duration:"1:02:03",cover:"https://source3.48.cn/c.jpg",privateField:"secret",playUrl:"https://idol-vod.48.cn/x.m3u8"});
  assert.equal(dto.liveId,"487000");assert.equal(dto.duration,"1:02:03");assert.equal(dto.durationSeconds,3723);
  assert.equal(JSON.stringify(dto).includes("secret"),false);
  assert.equal(JSON.stringify(dto).includes("idol-vod.48.cn"),false);
});
test("duration parsing rejects malformed clock strings",()=>{
  assert.equal(replay.durationSeconds("52:34"),3154);assert.equal(replay.durationSeconds("01:70"),null);assert.equal(replay.durationSeconds(""),null);
});
