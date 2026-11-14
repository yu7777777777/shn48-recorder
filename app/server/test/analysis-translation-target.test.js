"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const translation=require("../modules/analysis/translation");
const ai={url:"https://ai.test/v1",model:"m"};
test("each target language has its own column, version and instruction",()=>{
 const en=translation.identity(ai),ja=translation.identity(ai,"ja");
 assert.equal(en.target,"en");assert.equal(ja.target,"ja");
 assert.notEqual(en.$v,ja.$v);assert.notEqual(en.instruction,ja.instruction,"a Japanese instruction can never satisfy an English identity");
 assert.equal(translation.same(en,ja),false);
 assert.equal(translation.column("en"),"en","English keeps its historical column");assert.equal(translation.column("ja"),"enJA");
 assert.equal(translation.targetOf("JA"),"en","unknown or uppercase targets fall back to English");
 assert.equal(translation.targetOf("ja"),"ja");
});
test("a Japanese translation never overwrites the English column and does not reuse it",()=>{
 const en=translation.identity(ai),ja=translation.identity(ai,"ja");
 const english=translation.stamp({start:0,end:1,text:"你好"},"Hello",en);
 assert.equal(english.en,"Hello");assert.equal(translation.reusable(english,en),true);
 assert.equal(translation.reusable(english,ja),false,"an English row does not satisfy a Japanese request");
 const both=translation.stamp(english,"こんにちは",ja);
 assert.equal(both.en,"Hello");assert.equal(both.enJA,"こんにちは");
 assert.equal(translation.reusable(both,ja),true);
 assert.equal(translation.reusable(both,en),false,"the row records only the latest translation identity");
 // One row holds one provenance stamp, so it describes the newest translation; the
 // English text is kept, and the English identity can be restamped without a new
 // paid call only after that. Editing the source invalidates both, since enSource
 // is shared by the row.
 const edited={...both,text:"你好呀"};
 assert.equal(translation.reusable(edited,ja),false);assert.equal(translation.reusable(edited,en),false);
});
test("legacy rows without a target are read as English",()=>{
 const legacy={start:0,end:1,text:"你好",en:"Hello"};
 assert.equal(translation.reusable(legacy,translation.identity(ai)),false,"bare en is still not provenance");
 const stamped=translation.stamp({start:0,end:1,text:"你好"},"Hello",translation.identity(ai));
 const reloaded={...stamped,translation:{...stamped.translation,target:undefined}};
 assert.equal(translation.reusable(reloaded,translation.identity(ai)),true,"a stored row without target defaults to English instead of going stale");
});
