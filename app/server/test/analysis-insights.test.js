"use strict";
const test=require('node:test'), assert=require('node:assert/strict');
const {chunkSegments,fingerprint,validate,summarize}=require('../modules/analysis/insights');
const config={model:'m',url:'https://example.test/v1'};
const segments=[{start:0,end:10,text:'一'},{start:600,end:610,text:'二'}];
const row=(s,id)=>({start:s.start,end:s.end,title:'主题',summary:'内容',evidenceIds:[id??s.id]});
const valid=batch=>({summary:'概述',chapters:batch.map(s=>row(s)),highlights:[]});
test('dual limits include exact boundary, long gaps and stable global ids',()=>{
 const input=[{start:0,end:180,text:'字'.repeat(6000)},{start:180,end:360,text:'字'.repeat(6000)},{start:360,end:361,text:'三'},{start:4000,end:4001,text:'四'}];
 // 每条字幕本身就跨 180 秒，超过 150 秒的分片上限，因此各自独占一片。
 const chunks=chunkSegments(input); assert.deepEqual(chunks.map(b=>b.map(s=>s.id)),[[0],[1],[2],[3]]);
 // 分片跨度上限 150 秒（单条字幕上限仍是 360 秒，两者不是同一个常量）。
 // 单条字幕本身就比 150 秒长时无法再拆，此时以该条字幕的跨度为准。
 for(const b of chunks){
   const longest=Math.max(...b.map(s=>s.end-s.start));
   assert.ok(Math.max(...b.map(s=>s.end))-b[0].start<=Math.max(150,longest));
   assert.ok(b.reduce((n,s)=>n+s.text.length,0)<=12000);
 }
 assert.equal(chunkSegments([{start:0,end:1,text:'字'.repeat(7000)},{start:1,end:2,text:'字'.repeat(6000)}]).length,2);
 assert.throws(()=>chunkSegments([{start:0,end:361,text:'长'}]),/上限/);
 assert.throws(()=>chunkSegments([{start:0,end:1,text:'字'.repeat(12001)}]),/上限/);
});
test('strict schema rejects missing, forged, duplicate, fractional and non-overlapping evidence',()=>{
 const batch=chunkSegments([{start:0,end:10,text:'一'},{start:20,end:30,text:'二'}])[0];
 for(const ids of [undefined,[],[99],[0,0],[0.5],['0'],[1]]){
  const data=valid(batch);data.chapters[0].evidenceIds=ids;assert.throws(()=>validate(data,batch));
 }
 const data=valid(batch);data.chapters[0].extra=true;assert.throws(()=>validate(data,batch),/schema/);
 // 模型有时只返回 summary + chapters：没有精彩片段是合法结果，补空数组即可。
 const missing=valid(batch);delete missing.highlights;assert.deepEqual(validate(missing,batch).highlights,[]);
 const badHighlight=valid(batch);badHighlight.highlights=[{...row(batch[0]),evidenceIds:[99]}];assert.throws(()=>validate(badHighlight,batch),/引用/);
});
test('chapter bounds, finite times, evidence hull, overlaps and maximum five minutes',()=>{
 const batch=chunkSegments([{start:0,end:360,text:'一'}])[0];
 for(const changes of [{start:-1},{end:361},{start:NaN},{end:Infinity},{end:301}]){
  assert.throws(()=>validate({summary:'概述',chapters:[{...row(batch[0]),end:300,...changes}],highlights:[]},batch));
 }
 assert.throws(()=>validate({summary:'概述',chapters:[{...row(batch[0]),end:200},{...row(batch[0]),start:100}],highlights:[]},batch),/重叠/);
 const sparse=chunkSegments([{start:0,end:10,text:'一'},{start:20,end:30,text:'二'}])[0];
 // 章节边界不由引用包围范围约束（实际引用只是代表性几句，边界必然更宽）；
 // 但引用必须真实存在——伪造的 id 仍然整批拒绝。
 const forged=valid(sparse);forged.chapters[0].evidenceIds=[99];assert.throws(()=>validate(forged,sparse),/引用/);
});
test('omitted windows use valid candidates only or reject, not synthetic full coverage',()=>{
 const batch=chunkSegments([{start:0,end:10,text:'一'},{start:20,end:30,text:'二'}])[0];
 const data=valid(batch);data.chapters.pop();assert.throws(()=>validate(data,batch),/遗漏/);
 data.highlights=[row(batch[1])];const out=validate(data,batch);assert.equal(out.chapters.length,2);assert.deepEqual(out.chapters[1].evidenceIds,[1]);
 const long=chunkSegments([{start:0,end:360,text:'长'}])[0];
 const split=validate({summary:'概述',chapters:[],highlights:[row(long[0])]},long);assert.deepEqual(split.chapters.map(r=>[r.start,r.end]),[[0,300],[300,360]]);
 assert.deepEqual(validate(split,long),split);
});
test('successful blocks persist before next request; retry reuses only validated checkpoint',async()=>{
 let checkpoint, calls=[];
 const saveCheckpoint=async value=>{checkpoint=structuredClone(value);};
 await assert.rejects(()=>summarize({segments,config,saveCheckpoint,generate:async batch=>{calls.push(batch[0].id);if(batch[0].id===1){assert.equal(checkpoint.completed.length,1);throw Error('provider');}return valid(batch);}}),/provider/);
 // Each unfinished chunk is requested once; paid retries belong to the queue.
 assert.deepEqual(calls,[0,1]); calls=[];
 const out=await summarize({segments,config,checkpoint,saveCheckpoint,generate:async batch=>{calls.push(batch[0].id);return valid(batch);}});
 assert.deepEqual(calls,[1]);assert.equal(out.summaryCoverage.complete,true);assert.deepEqual(out.summaryCoverage.gaps,[{start:10,end:600}]);assert.equal(out.summaryCoverage.scope,'subtitle-timeline');
 checkpoint.completed[0].chapters[0].evidenceIds=[99];calls=[];
 await summarize({segments,config,checkpoint,saveCheckpoint,generate:async batch=>{calls.push(batch[0].id);return valid(batch);}});assert.deepEqual(calls,[0,1]);
});
test('text, timestamps, model and endpoint invalidate old checkpoints; translation does not',async()=>{
 let checkpoint;await summarize({segments,config,generate:async b=>valid(b),saveCheckpoint:v=>{checkpoint=structuredClone(v);}});
 for(const [ss,cc] of [[[{...segments[0],text:'改'},segments[1]],config],[[{...segments[0],end:11},segments[1]],config],[segments,{...config,model:'n'}],[segments,{...config,url:'https://other.test'}]]){
  let calls=0;await summarize({segments:ss,config:cc,checkpoint,generate:async b=>{calls++;return valid(b);},saveCheckpoint:()=>{}});assert.equal(calls,2);
 }
 assert.equal(fingerprint(segments,config),fingerprint(segments.map(s=>({...s,en:'English'})),config));
 let calls=0;await summarize({segments,config,checkpoint:{completed:checkpoint.completed,fingerprint:checkpoint.fingerprint},generate:async b=>{calls++;return valid(b);},saveCheckpoint:()=>{}});assert.equal(calls,2);
});
test('cross-chunk overlapping source times merge without fabricated references',async()=>{
 const overlapping=[{start:0,end:10,text:'字'.repeat(7000)},{start:5,end:15,text:'字'.repeat(7000)}];
 const out=await summarize({segments:overlapping,config,generate:async b=>valid(b),saveCheckpoint:()=>{}});
 assert.deepEqual(out.chapters.map(r=>[r.start,r.end,r.evidenceIds]),[[0,10,[0]],[10,15,[1]]]);
 assert.equal(out.summaryCoverage.complete,true);
});
test('cancel and failed persistence cannot return a completed replacement',async()=>{
 const controller=new AbortController();let saved=0;
 await assert.rejects(()=>summarize({segments,config,signal:controller.signal,generate:async b=>{controller.abort();return valid(b);},saveCheckpoint:()=>saved++}));assert.equal(saved,0);
 await assert.rejects(()=>summarize({segments,config,generate:async b=>valid(b),saveCheckpoint:()=>{throw Error('disk full');}}),/disk full/);
 const final=new AbortController();await assert.rejects(()=>summarize({segments,config,signal:final.signal,generate:async b=>valid(b),saveCheckpoint:()=>{},onProgress:(done,total)=>{if(done===total)final.abort();}}));
});

test('partially overlapping evidence keeps the valid citations instead of failing the whole batch',()=>{
 // 真实故障：模型给章节挂多个引用，其中个别 id 与片段时间不重叠，
 // 旧逻辑一条不达标就整批拒绝，表现为反复报「AI 引用与实际字幕时间不重叠」。
 const batch=chunkSegments([{start:0,end:10,text:'一'},{start:20,end:30,text:'二'},{start:40,end:50,text:'三'}])[0];
 // 用 highlights 表达单条片段，避开章节必须全覆盖的额外约束；
 // 0 号与 [20,30] 不重叠，应被剔除，剩下 1 号仍然有效。
 const one={summary:'概述',chapters:[{start:0,end:50,title:'整场',summary:'内容',evidenceIds:[0,1,2]}],highlights:[{start:20,end:30,title:'精彩',summary:'内容',evidenceIds:[0,1]}]};
 const out=validate(one,batch);
 assert.deepEqual(out.highlights[0].evidenceIds,[1]);
 // 伪造或越界 id 依然整批拒绝，不能被静默过滤
 for(const ids of [[99],[0,99],[0,0],[0.5],['0']]){
  const bad={summary:'概述',chapters:[{start:0,end:50,title:'主题',summary:'内容',evidenceIds:ids}],highlights:[]};
  assert.throws(()=>validate(bad,batch),/无效或伪造/);
 }
});

test('chapters declaring a wide span with few citations are accepted; blank-space padding is rejected',()=>{
 // 线上真实形态：一段 2 分钟的章节只挂 2 到 3 条代表性引用。
 // 旧逻辑把章节裁到引用的紧致范围，剩余时间变成缺口，最终报「遗漏字幕时间窗口」。
 // 这条测试验证的是"一个分片内的章节形态"，分片大小是别的用例的事，
 // 因此直接把整段字幕当成一个 batch，避免受分片上限变化影响。
 const batch=Array.from({length:36},(_,i)=>({id:i,start:i*10,end:i*10+10,text:'第'+i+'句'}));
 const last=batch[batch.length-1];
 const wide={summary:'这是一场直播的概述内容。',chapters:[
  {start:0,end:120,title:'开场与准备',summary:'介绍今天的安排。',evidenceIds:[0,1,2]},
  {start:120,end:240,title:'聊天环节',summary:'聊到近况和行程。',evidenceIds:[15,16,17]},
  {start:240,end:last.end,title:'收尾与告别',summary:'回答观众提问。',evidenceIds:[28,29]},
 ],highlights:[]};
 const out=validate(wide,batch);
 assert.deepEqual(out.chapters.map(c=>[c.start,c.end]),[[0,120],[120,240],[240,last.end]]);
 assert.equal(out.chapters[0].evidenceIds.length,3);
 // 但边界伸进"没有字幕的空白"仍然是编时间，必须拒绝
 const padded={...wide,chapters:wide.chapters.map((c,i)=>i?c:{...c,start:-1})};
 // start:-1 越过分片边界，属于编时间，必须拒绝。
 assert.throws(()=>validate(padded,batch));
});

test('silence between utterances is not a coverage gap',()=>{
 // 真实录像里每段台词之间都有静音，AI 不会为静音写章节。
 // 旧实现把所有字幕合并成一条大窗口，静音也要求被覆盖，覆盖校验必然失败。
 const segs=[];
 for(let i=0;i<40;i++) segs.push({start:i*30,end:i*30+10,text:'第'+i+'句'}); // 每句后留 20 秒静音
 const batch=chunkSegments(segs)[0];
 const rows=[...batch].sort((a,b)=>a.start-b.start);
 const groups=[];let cur=[rows[0]];
 for(let k=1;k<rows.length;k++){ if(rows[k].start-cur[cur.length-1].end<=3) cur.push(rows[k]); else {groups.push(cur);cur=[rows[k]];} }
 groups.push(cur);
 const chapters=groups.map(g=>({start:g[0].start,end:g[g.length-1].end,title:'段落',summary:'内容描述。',evidenceIds:[...new Set([g[0].id,g[g.length-1].id])]}));
 const out=validate({summary:'这是这场直播的概述内容。',chapters,highlights:[]},batch);
 assert.ok(out.chapters.length>0);
 // 但真正有台词却漏写，仍然要报覆盖不全
 const dropped={summary:'这是这场直播的概述内容。',chapters:chapters.slice(0,1),highlights:[]};
 assert.throws(()=>validate(dropped,batch),/遗漏/);
});
