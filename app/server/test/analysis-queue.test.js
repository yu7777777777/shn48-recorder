'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const queue=require('../modules/analysis/queue');
function config(extra={}){return {ai:{url:'https://offline.test/v1',model:'m',key:'not-stored'},queue:{autoRetry:true,maxRetries:3,resumeInterrupted:false,...extra}};}
function job(c=config()){return {status:'running',kind:'translate',retryCount:0,attempts:1,configFingerprint:queue.fingerprint(c,'translate')};}
test('queue backoff is exactly 5/15/60 minutes, bounded by cumulative budget',()=>{
 const c=config(),j=job(c),now=100000;for(const minutes of [5,15,60]){assert.equal(queue.retry(j,{httpStatus:503},c,now),true);assert.equal(Date.parse(j.nextAttemptAt)-now,minutes*60000);}assert.equal(j.retryCount,3);assert.equal(queue.retry(j,{httpStatus:503},c,now),false);
 for(const count of [0,1,2,3]){const x=job(c);x.retryCount=count;assert.equal(queue.retry(x,{httpStatus:429},config({maxRetries:count}),now),false);}
});
test('only transient HTTP and network errors are eligible; default is opt out',()=>{
 for(const status of [408,429,500,503,599])assert.equal(queue.retry(job(),{httpStatus:status},config(),0),true);
 for(const error of [{httpStatus:401},{httpStatus:403},{httpStatus:400},{statusCode:500},{code:'ENOSPC'},Error('schema'),Error('cancel')])assert.equal(queue.retry(job(),error,config(),0),false);
 assert.equal(queue.retry(job(),{networkError:true},config(),0),true);
 assert.equal(queue.retry(job(),{httpStatus:503},{...config(),queue:{}},0),false);
});
test('Retry-After respects provider hints but never exceeds 24 hours',()=>{
 for(const [hint,delay] of [[0,300000],[900000,900000],[Infinity,300000],[172800000,86400000],[-1,300000]]){const j=job();queue.retry(j,{httpStatus:429,retryAfterMs:hint},config(),0);assert.equal(Date.parse(j.nextAttemptAt),delay);}
});
test('recovery preserves ordinary queued, safely fails running, and shares bounded opt-in budget',()=>{
 const pending={status:'queued',kind:'translate'},interrupted=job();queue.recover([pending,interrupted],config(),0);assert.equal(pending.status,'queued');assert.equal(interrupted.status,'failed');assert.equal(interrupted.recovery.resumed,false);
 const c=config({autoRetry:false,resumeInterrupted:true}),j=job(c);for(let i=0;i<3;i++){j.status='running';queue.recover([j],c,i);assert.equal(j.status,'queued');assert.equal(j.retryCount,i+1);assert.equal(j.recovered,true);}j.status='running';queue.recover([j],c,4);assert.equal(j.status,'failed');
 const cancelled={...job(c),cancelled:true};queue.recover([cancelled],c,0);assert.equal(cancelled.status,'failed');
});
test('new queue entries take priority over due retries and future retries stay asleep',()=>{
 const retry={status:'queued',retryMode:'automatic',nextAttemptAt:new Date(100).toISOString()},fresh={status:'queued'};
 assert.equal(queue.next([retry,fresh],100),fresh);assert.equal(queue.next([retry],99),undefined);assert.equal(queue.next([retry],100),retry);assert.equal(queue.wakeAt([retry]),100);
});
test('old retries cannot follow disabled switches or changed endpoint/model/budget',()=>{
 const c=config(),j=job(c);queue.retry(j,{httpStatus:503},c,0);assert.equal(queue.allowed(j,c),true);
 assert.equal(queue.allowed(j,config({autoRetry:false})),false);assert.equal(queue.allowed(j,config({maxRetries:0})),false);
 for(const change of [{url:'https://different.test'},{model:'new'}])assert.equal(queue.allowed(j,{...c,ai:{...c.ai,...change}}),false);
 assert.equal(j.configFingerprint.includes(c.ai.key),false);
});
test('history compaction retains all early queued/running work and latest terminal history in original order',()=>{
 const early={id:'early',status:'queued'},active={id:'active',status:'running'},history=Array.from({length:305},(_,id)=>({id,status:id%2?'failed':'done'})),jobs=[early,...history.slice(0,100),active,...history.slice(100)],original=[...jobs];
 const saved=queue.compact(jobs,300);assert.equal(saved.length,302);assert.equal(saved[0],early);assert.equal(saved.includes(active),true);assert.deepEqual(saved.filter(j=>typeof j.id==='number').map(j=>j.id),Array.from({length:300},(_,i)=>i+5));assert.deepEqual(jobs,original);assert.deepEqual(queue.compact([early,...history,active],0),[early,active]);
});
test('injected timers wake without real sleep, unref, replace, and clear cleanly',()=>{
 let now=0,seq=0,wakes=0,unrefs=0;const timers=new Map();const wake=queue.createWakeup({now:()=>now,setTimer:(fn,delay)=>{const timer={id:++seq,unref(){unrefs++;}};timers.set(timer,{fn,at:now+delay});return timer;},clearTimer:t=>timers.delete(t),wake:()=>wakes++});
 wake.arm(300000);assert.equal(unrefs,1);assert.equal(timers.size,1);wake.arm(900000);assert.equal(timers.size,1);now=900000;const [fired,value]=[...timers][0];timers.delete(fired);value.fn();assert.equal(wakes,1);wake.arm(3600000);wake.clear();assert.equal(timers.size,0);
});
