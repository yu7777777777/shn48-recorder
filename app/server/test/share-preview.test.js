"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48share-"));
process.env.DATA_DIR=path.join(root,"data");
const preview=require("../modules/analysis/share-preview");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const shell="<!doctype html><html><head><title>48tools</title><meta charset=\"utf-8\" /></head><body></body></html>";
test("only a published replay page gets its own tags",()=>{
 const published={title:"2026-10-01 直播",summary:"今晚聊了新歌与巡演安排。"};
 const tags=preview.tagsFor("/replays/live_123",()=>published);
 assert.deepEqual(tags,{title:"2026-10-01 直播 · 回放总结",description:"今晚聊了新歌与巡演安排。"});
 assert.equal(preview.tagsFor("/replays/live_123",()=>null),null,"unpublished replays keep the generic card");
 assert.equal(preview.tagsFor("/replays",()=>published),null);
 assert.equal(preview.tagsFor("/admin/overview",()=>published),null);
 assert.equal(preview.tagsFor("/s/abc",()=>published),null,"access-code pages do not advertise a member");
});
test("titles and descriptions are truncated and HTML-escaped",()=>{
 const tags=preview.tagsFor("/replays/x",()=>({title:"<b>标题</b>",summary:"A".repeat(400)+"\n换行"}));
 assert.match(tags.title,/&lt;b&gt;/);
 assert.equal(tags.title.includes("<b>"),false);
 assert.equal(tags.description.length<=180,true);
 assert.equal(tags.description.includes("\n"),false);
});
test("injection replaces the generic title and adds one card",()=>{
 const html=preview.inject(shell,{title:"标题 · 回放总结",description:"描述"});
 assert.equal(html.includes("<title>标题 · 回放总结</title>"),true);
 assert.equal(html.includes("48tools</title>"),false);
 assert.equal(html.match(/og:title/g).length,1);
 assert.equal(html.includes("</head>"),true);
 assert.equal(preview.inject(shell,null),shell,"no tags means the shell is untouched");
});
test("the served page carries the card for a published replay only",async()=>{
 const http=require("node:http");
 const app=require("express")();
 app.get("/replays/:id",(req,res)=>{
  const tags=preview.tagsFor(req.path,id=>id==="ok"?{title:"已发布",summary:"摘要"}:null);
  if(!tags)return res.type("html").send(shell);
  res.type("html").send(preview.inject(shell,tags));
 });
 const server=http.createServer(app);
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 try {
  const base=`http://127.0.0.1:${server.address().port}/replays/`;
  const ok=await (await fetch(base+"ok")).text();
  assert.match(ok,/property="og:title" content="已发布 · 回放总结"/);
  const skip=await (await fetch(base+"draft")).text();
  assert.equal(skip.includes("og:title"),false);
 } finally { server.closeAllConnections();await new Promise(r=>server.close(r)); }
});
