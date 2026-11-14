"use strict";
const { setTimeout: delay } = require('node:timers/promises');
function gaps(duration, ranges, chunkSeconds) {
  const queue = []; let cursor = 0;
  for (const [start, end] of [...ranges, [duration, duration]].sort((a,b)=>a[0]-b[0])) {
    while (cursor < start) { const length = Math.min(chunkSeconds, start-cursor); queue.push({offset:cursor,length,attempt:0}); cursor += length; }
    cursor = Math.max(cursor, end);
  }
  return queue;
}
async function parallelAsr({ start=0, ranges=[[0,start]], duration, chunkSeconds, concurrency, signal, prepare, recognize, commit, cleanup=()=>{}, size=()=>0, maxBytes=24000000, onThrottle=()=>{}, sleep=(ms)=>delay(ms,undefined,{signal}) }) {
  const queue = gaps(duration,ranges,chunkSeconds), active = new Set();
  let uploading=0, limit=concurrency, cooldown=0, firstError, preparation=Promise.resolve();
  async function task(part) {
    let input;
    try {
      // Only one encoder at a time; network requests continue during extraction.
      const ready=preparation.then(()=>{signal.throwIfAborted();return prepare(part.offset,part.length);});
      preparation=ready.catch(()=>{}); input=await ready;
      signal.throwIfAborted();
      if(size(input)>maxBytes) throw Object.assign(new Error('音频分片超过上传大小限制'),{httpStatus:413});
      while (uploading>=limit || Date.now()<cooldown) {
        signal.throwIfAborted(); await sleep(Math.max(25,Math.min(1000,cooldown-Date.now())));
      }
      signal.throwIfAborted(); uploading++;
      let result;
      try {result=await recognize(input,part.offset,part.length);} finally {uploading--;}

      signal.throwIfAborted(); await commit(result,part.offset,part.length);
    } catch(error) {
      if(signal.aborted) return;
      if([413,524].includes(error.httpStatus) && part.length>=120) {
        const half=part.length/2;
        queue.unshift({offset:part.offset,length:half,attempt:0},{offset:part.offset+half,length:part.length-half,attempt:0});
      } else if(error.httpStatus===429 && part.attempt<3) {
        limit=Math.max(1,Math.floor(limit/2));
        cooldown=Math.max(cooldown,Date.now()+Math.max(error.retryAfterMs||0,1000*2**part.attempt));
        queue.push({...part,attempt:part.attempt+1});onThrottle(limit);
      } else { firstError ||= error; }
    } finally { if(input!==undefined) cleanup(input); }
  }
  while(queue.length || active.size) {
    if(signal.aborted){await Promise.allSettled(active);signal.throwIfAborted();}
    if(queue.length && active.size<limit && Date.now()>=cooldown) {
      const promise=task(queue.shift()).finally(()=>active.delete(promise));active.add(promise);continue;
    }
    if(active.size) await Promise.race(active);
    else if(queue.length) await sleep(Math.max(0,cooldown-Date.now()));
  }
  signal.throwIfAborted();if(firstError)throw firstError;
}
module.exports=parallelAsr;
module.exports.gaps=gaps;
