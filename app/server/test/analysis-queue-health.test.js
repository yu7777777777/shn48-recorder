"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const queue=require("../modules/analysis/queue");
const config=(q={})=>({asr:{url:"https://asr.test/v1",model:"w"},ai:{url:"https://ai.test/v1",model:"m"},queue:{autoRetry:false,maxRetries:3,resumeInterrupted:false,...q}});
const job=(extra={})=>({id:"j",recordingId:"r",kind:"translate",status:"queued",retryCount:0,...extra});
test("health counts each terminal state and never leaks payload or paths",()=>{
 const rows=[job(),job({id:"j2",status:"running"}),job({id:"j3",status:"done"}),job({id:"j4",status:"failed",error:"x",config:{key:"secret"}})];
 const out=queue.health(rows,config(),1000);
 assert.equal(out.queued,1);assert.equal(out.running,1);assert.equal(out.done,1);assert.equal(out.failed,1);
 assert.equal(JSON.stringify(out).includes("secret"),false);
 assert.equal(out.localOnly,true);
 assert.deepEqual(out.policy,{autoRetry:false,resumeInterrupted:false,maxRetries:3});
});
test("work parked behind a closed switch is reported separately from dormant retries",()=>{
 const fp=queue.fingerprint(config(),"translate");
 const rows=[
  job({id:"auto",status:"queued",retryMode:"automatic",retryCount:1,configFingerprint:fp,nextAttemptAt:new Date(5000).toISOString()}),
  job({id:"rec",status:"queued",retryMode:"recovery",retryCount:1,configFingerprint:fp}),
  job({id:"plain",status:"queued"})
 ];
 const out=queue.health(rows,config(),1000);
 // autoRetry is off here, so both the automatic and recovery retries are blocked.
 assert.equal(out.blockedByDisallowedPolicy,2);
 assert.equal(out.dormantRetries,1);assert.equal(out.nextWakeAt,new Date(5000).toISOString());
 const enabled=queue.health(rows,config({autoRetry:true,resumeInterrupted:true}),1000);
 assert.equal(enabled.blockedByDisallowedPolicy,0);
 assert.equal(enabled.dormantRetries,1,"a future retry is dormant but allowed");
});
test("recovery outcome of the last start is counted, not inferred",()=>{
 const rows=[
  job({id:"a",status:"queued",recovery:{interruptedAt:"2026-01-01T00:00:00.000Z",resumed:true}}),
  job({id:"b",status:"failed",recovery:{interruptedAt:"2026-01-01T00:00:00.000Z",resumed:false}}),
  job({id:"c",status:"done"})
 ];
 const out=queue.health(rows,config());
 assert.equal(out.recoveredLastStart,1);assert.equal(out.interruptedLastStart,1);
 assert.equal(queue.health(null,config()).queued,0,"missing or corrupt data degrades to zero");
 assert.equal(queue.health([null,{},{status:"queued"}],config()).queued,1);
});
