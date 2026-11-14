"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const translation=require("../modules/analysis/translation");
const ai={url:"http://127.0.0.1:9999/v1",model:"fake-model"};
const seg=(text="原句")=>({start:0,end:1,text});
test("a recorded translation is reusable only for the same endpoint, model, instruction and source text",()=>{
 const id=translation.identity(ai), row=translation.stamp(seg("甲"),"A",id);
 assert.equal(translation.reusable(row,id),true);
 assert.equal(translation.reusable(row,translation.identity({...ai,model:"other"})),false);
 assert.equal(translation.reusable(row,translation.identity({...ai,url:"http://127.0.0.1:9998/v1"})),false);
 assert.equal(translation.reusable(translation.stamp(seg("乙"),"A",id),id),true);
 assert.equal(translation.reusable({...row,text:"乙"},id),false,"edited source must invalidate");
 assert.equal(translation.reusable({...row,en:"  "},id),false,"blank English must not count");
});
test("legacy bare English without provenance is never reused",()=>{
 const id=translation.identity(ai);
 assert.equal(translation.reusable({start:0,end:1,text:"旧",en:"Old"},id),false);
 assert.equal(translation.reusable({start:0,end:1,text:"旧",en:"Old",translation:{...id}},id),false,"missing enSource");
 assert.equal(translation.stale({start:0,end:1,text:"旧",en:"Old"},id),true);
});
test("stamping replaces prior provenance and keeps the source text untouched",()=>{
 const a=translation.identity(ai),b=translation.identity({...ai,model:"m2"});
 const once=translation.stamp(seg("甲"),"A",a),twice=translation.stamp(once,"A2",b);
 assert.equal(twice.translation.model,"m2");assert.equal(twice.en,"A2");assert.equal(twice.text,"甲");
 assert.equal(translation.reusable(twice,b),true);assert.equal(translation.reusable(twice,a),false);
});
test("instruction and version are part of the identity hash",()=>{
 const id=translation.identity(ai);
 assert.equal(id.instruction,translation.hash(translation.INSTRUCTION));
 assert.match(translation.INSTRUCTION,/translations/);
 assert.equal(translation.VERSION,"en-v1");
 assert.notEqual(translation.hash("a"),translation.hash("b"));
});
