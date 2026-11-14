"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const align=require('../modules/analysis/lexicon-align');
// 本地策略，非上游规则：上游靠 DashScope 服务端声学热词，本地第三方 whisper 没有这条通道。
test('near matches only single-character differences of equal length',()=>{
 assert.equal(align.near('徐佳琦','徐佳琪'),1);
 assert.equal(align.near('徐佳琪','徐佳琪'),0);
 assert.equal(align.near('徐佳','徐佳琪'),0);
 assert.equal(align.near('徐佳琪琪','徐佳琪'),0);
 assert.equal(align.near('徐佳琪','沈梦瑶'),0);
 assert.equal(align.near('甲','乙'),0);
});
test('build keeps long-enough terms and aliases, drops disabled rows',()=>{
 const v=align.build([{term:'徐佳琪',aliases:'佳琪'},{term:'塞纳河'},{term:'沈梦瑶',enabled:false},{term:'甲'},{term:'  '}]);
 assert.deepEqual(v,['徐佳琪','佳琪','塞纳河']);
 assert.deepEqual(align.build(undefined),[]);
 assert.throws(()=>align.build(new Array(501).fill({term:'甲乙'})),/最多/);
});
test('apply fixes one-character mishearing and leaves correct or unrelated text alone',()=>{
 const v=align.build([{term:'徐佳琪',aliases:'佳琪'},{term:'塞纳河'},{term:'沈梦瑶'}]);
 assert.deepEqual(align.apply('徐佳琦今天唱得很好',v).text,'徐佳琪今天唱得很好');
 assert.deepEqual(align.apply('佳棋说她要休息',v).text,'佳琪说她要休息');
 assert.deepEqual(align.apply('今天徐佳琪来了',v).text,'今天徐佳琪来了');
 assert.deepEqual(align.apply('塞纳河的晚霞真好看',v).text,'塞纳河的晚霞真好看');
 const plain=align.apply('今天天气不错我们出去玩',v);
 assert.equal(plain.changes,0);assert.equal(plain.text,'今天天气不错我们出去玩');
});
test('apply abandons the term when the match is ambiguous or absent',()=>{
 const v=align.build([{term:'徐佳琪'}]);
 // 两处都能对上 -> 宁可不动，避免连锁误改
 const twice=align.apply('徐佳琦和徐佳琪都在',v);
 assert.equal(twice.changes,0,'已含正字时不应再改');
 assert.deepEqual(align.apply('徐佳琦和徐佳琪都在',v).text,'徐佳琦和徐佳琪都在');
 assert.equal(align.apply('',v).changes,0);
 assert.equal(align.apply('徐佳琦',[]).changes,0);
 assert.equal(align.apply('徐佳琦',undefined).changes,0);
});
test('stop words are never rewritten into glossary terms',()=>{
 const v=align.build([{term:'他今田'}]);
 const out=align.apply('他今天很好',v);
 assert.equal(out.changes,0);
 assert.equal(out.text,'他今天很好');
});
