"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const glossary=require("../modules/analysis/glossary");
test("names are normalised to one spelling so duplicates collapse",()=>{
 const out=glossary.normalize([{term:"　熊紫轶 ",aliases:"小熊，小 熊、小熊"},{term:"熊紫轶",aliases:"熊熊"},{term:"  ",aliases:"x"}]).value;
 assert.equal(out.length,1);
 assert.equal(out[0].term,"熊紫轶");
 assert.equal(out[0].aliases,"小熊, 小 熊, 熊熊");assert.equal(glossary.normalize([{term:"甲",aliases:"小 熊"},{term:"乙",aliases:"小熊"}]).conflicts.length,0,"inner spacing is a different spelling, not a silent merge");
 assert.equal(out[0].enabled,true);
});
test("full-width and ascii spellings of the same name unify",()=>{
 const out=glossary.normalize([{term:"ＡＫＢ４８"},{term:"AKB48"}]).value;
 assert.equal(out.length,1);assert.equal(out[0].term,"AKB48");
});
test("a name owned by two different members is reported, not silently merged",()=>{
 const out=glossary.normalize([{term:"小熊",memberId:"100"},{term:"小熊熊",aliases:"小熊",memberId:"200"},{term:"小熊",memberId:"100"}]);
 assert.deepEqual(out.conflicts,[{name:"小熊",owners:["100","200"]}]);
 assert.equal(out.value.length,2);
});
test("member ids must be numeric and are kept per row",()=>{
 const out=glossary.normalize([{term:"陈琳",memberId:"12345"},{term:"禹佳蔚",memberId:"../x"},{term:"刘小涵",member:{id:"777"}}]).value;
 assert.equal(out[0].memberId,"12345");assert.equal(out[1].memberId,"");assert.equal(out[2].memberId,"777");
});
test("limits and malformed input are refused",()=>{
 assert.throws(()=>glossary.normalize(null),/词库格式无效/);
 assert.throws(()=>glossary.normalize(Array.from({length:501},(_,i)=>({term:"n"+i}))),/最多 500 条/);
});
test("saving settings stores normalised rows and surfaces conflicts",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glossary-normalise-"));process.env.DATA_DIR=root;
 try{const settings=require("../modules/analysis/settings");
  const saved=settings.save({glossary:[{term:"熊紫轶",aliases:"小熊、小熊",memberId:"100"},{term:" 熊紫轶 ",memberId:"100"},{term:"小熊熊",aliases:"小熊",memberId:"200"}]});
  assert.equal(saved.glossary.length,2);
  assert.equal(saved.glossary[0].term,"熊紫轶");assert.equal(saved.glossary[0].aliases,"小熊");assert.equal(saved.glossary[0].memberId,"100");
  assert.deepEqual(saved.glossaryConflicts,[{name:"小熊",owners:["100","200"]}]);
  assert.throws(()=>settings.save({glossary:null}),/词库格式无效/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});