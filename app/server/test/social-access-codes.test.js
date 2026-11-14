"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"48access-"));
process.env.DATA_DIR=path.join(root,"data");
const access=require("../modules/social/access"),store=require("../lib/store");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const clock=(ms)=>({now:()=>ms});
test("a code is returned once and only its hash is stored",()=>{
 const created=access.create("成员甲",{hours:1},clock(Date.parse("2026-10-01T00:00:00Z")));
 assert.match(created.code,/^[A-Za-z0-9_-]{16,64}$/);
 const saved=fs.readFileSync(store.filePath(access.KEY),"utf8");
 assert.equal(saved.includes(created.code),false,"the plaintext code is never persisted");
 const listed=access.list(clock(Date.parse("2026-10-01T00:30:00Z")));
 assert.equal(listed.length,1);assert.equal(listed[0].memberName,"成员甲");assert.equal(listed[0].expired,false);
 assert.equal(JSON.stringify(listed).includes(created.code),false);
 assert.equal(Object.hasOwn(listed[0],"hash"),false,"the list never exposes the stored hash");
});
test("codes expire, resolve only while valid and can be revoked",()=>{
 const created=access.create("成员乙",{hours:2},clock(Date.parse("2026-10-02T00:00:00Z")));
 const before=clock(Date.parse("2026-10-02T01:59:00Z")),after=clock(Date.parse("2026-10-02T02:01:00Z"));
 assert.deepEqual(access.resolve(created.code,before),{memberName:"成员乙"});
 assert.equal(access.resolve(created.code,after),null,"an expired code stops working");
 const id=access.list(after).find(row=>row.memberName==="成员乙" && row.expired).id;
 access.revoke(id);
 assert.equal(access.list(before).some(row=>row.memberName==="成员乙"),false);
 assert.throws(()=>access.revoke(id),/访问码不存在/);
});
test("one code per member is kept and input is validated",()=>{
 const t=clock(Date.parse("2026-10-03T00:00:00Z"));
 const first=access.create("成员丙",{},t);
 const second=access.create("成员丙",{},t);
 assert.equal(access.resolve(first.code,t),null,"a replaced code stops working");
 assert.deepEqual(access.resolve(second.code,t),{memberName:"成员丙"});
 assert.throws(()=>access.create("",{},t),/请选择要分享的成员/);
 assert.throws(()=>access.create("成员丁",{hours:0},t),/有效期须为 1 到 720 小时/);
 assert.throws(()=>access.create("成员丁",{hours:721},t),/有效期须为 1 到 720 小时/);
 assert.equal(access.resolve("short",t),null);assert.equal(access.resolve("../../etc/passwd",t),null);
});
test("the guest payload carries only that member's public account fields",async()=>{
 const accounts=[
  {id:"a1",memberName:"成员甲",platform:"weibo",accountId:"12345",accountName:"昵称",note:"管理员私有备注",createdAt:"x",updatedAt:"x",size:"main"},
  {id:"a2",memberName:"成员乙",platform:"douyin",accountId:"999",accountName:"别人",note:"不该出现"}
 ];
 const rows=access.publicAccounts(accounts,"成员甲");
 assert.deepEqual(rows,[{platform:"weibo",accountId:"12345",accountName:"昵称",groupKind:"",profileUrl:""}]);
 assert.equal(JSON.stringify(rows).includes("私有备注"),false,"notes are never published");
 assert.equal(JSON.stringify(rows).includes("999"),false,"another member is not published");
});
test("the public route refuses a bad code and answers with no-store",async()=>{
 const t=clock(Date.now());
 const created=access.create("成员戊",{hours:1},t);
 const app=require("express")();
 app.use("/api/public",require("../routes/public"));
 const server=http.createServer(app);
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 try {
  const base=`http://127.0.0.1:${server.address().port}/api/public/social/`;
  const bad=await fetch(base+"not-a-real-code-123456");
  assert.equal(bad.status,404);
  const body=await bad.json();assert.equal(body.success,false);
  const good=await fetch(base+created.code);
  assert.equal(good.status,200);
  assert.equal(good.headers.get("cache-control"),"no-store");
  assert.equal(typeof (await good.json()).data.memberName,"string");
 } finally { server.closeAllConnections();await new Promise(r=>server.close(r)); }
});
test("every successful visit is counted and time-stamped, without storing who",()=>{
  const t=clock(Date.parse("2026-10-05T00:00:00Z"));
  const created=access.create("成员己",{hours:5},t);
  const later=clock(Date.parse("2026-10-05T01:00:00Z"));
  access.resolve(created.code,later);
  access.resolve(created.code,clock(Date.parse("2026-10-05T02:00:00Z")));
  assert.equal(access.resolve("wrongcode00000000",later),null);
  const row=access.list(later).find(item=>item.memberName==="成员己");
  assert.equal(row.uses,2,"only successful resolutions count");
  assert.equal(row.lastUsedAt,"2026-10-05T02:00:00.000Z");
  assert.equal(Object.hasOwn(row,"hash"),false);
  const saved=fs.readFileSync(store.filePath(access.KEY),"utf8");
  assert.equal(saved.includes("127.0.0.1"),false,"no IP or user agent is recorded");
 });
 