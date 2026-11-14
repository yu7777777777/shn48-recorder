"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48publish-"));
process.env.DATA_DIR=path.join(root,"data");
const settings=require("../modules/analysis/settings");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test("published replay summaries are off until an administrator opts in",()=>{
 const initial=settings.publicSettings();
 assert.deepEqual(initial.publish,{summary:false,chapters:true,highlights:true});
 assert.deepEqual(initial.publicDetail,{mode:'full'},'the default keeps the summary text');
 assert.equal(settings.get().publish.summary,false);
});
test("each publish switch can be set independently and survives a partial save",()=>{
 settings.save({publish:{summary:true}});
 assert.deepEqual(settings.get().publish,{summary:true,chapters:true,highlights:true});
 settings.save({publish:{highlights:false}});
 assert.deepEqual(settings.get().publish,{summary:true,chapters:true,highlights:false},"an omitted key keeps its saved value");
 settings.save({publish:{summary:false}});
 assert.equal(settings.publicSettings().publish.summary,false);
});
test("invalid publish input is rejected instead of being ignored",()=>{
 assert.throws(()=>settings.save({publish:{summary:"yes"}}),/公开开关必须为布尔值/);
 assert.throws(()=>settings.save({publish:{unknown:true}}),/公开设置无效/);
 assert.throws(()=>settings.save({publish:[]}),/公开设置无效/);
 assert.equal(settings.get().publish.summary,false,"a rejected save leaves the stored value untouched");
});
test("public detail can drop the summary text while keeping chapter titles",()=>{
 settings.save({publish:{summary:true}});
 settings.save({publicDetail:{mode:"chapters"}});
 assert.deepEqual(settings.get().publicDetail,{mode:"chapters"});
 assert.throws(()=>settings.save({publicDetail:{mode:"everything"}}),/公开详略只能选择完整或仅分级/);
 assert.throws(()=>settings.save({publicDetail:{mode:"full",extra:1}}),/公开详略设置无效/);
 assert.equal(settings.get().publicDetail.mode,"chapters","a rejected save keeps the previous mode");
 settings.save({publicDetail:{mode:"full"}});
});
 