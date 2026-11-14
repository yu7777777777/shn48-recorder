import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
const require=createRequire(new URL('../../server/package.json',import.meta.url));
const express=require('express'), {chromium}=require('playwright');

// UI transport is mocked; repository persistence and authentication are tested
// separately by server/test/social.test.js. No real social accounts are used.
test('social accounts use notes, safe nickname lookup, CRUD, groups and mobile navigation', {timeout:90000}, async()=>{
 // Transform current source in memory: stale dist must not hide regressions and
 // this test must not build artifacts owned by the release/main session.
 const app=express(),root=fileURLToPath(new URL('../',import.meta.url));
 const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'custom'});
 app.use(vite.middlewares);
 app.get('*',async(req,res,next)=>{
  try{res.type('html').send(await vite.transformIndexHtml(req.originalUrl,readFileSync(root+'index.html','utf8')));}catch(error){next(error);}
 });
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium')});
  const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true});
  page.setDefaultTimeout(6000);
  const errors=[],writes=[],lookups=[],heldLookups=new Map();let rows=[],sequence=0,failRead=false,failRoster=false,failSave=false,holdSave=false,releaseSave;let rosterReads=0;
  let lookupMode='success',notifyLookup;
  const releaseLookup=async(id,platform='weibo')=>{
   const key=platform+':'+id;
   assert.ok(heldLookups.has(key),`lookup ${key} must be pending`);
   await heldLookups.get(key)();heldLookups.delete(key);
  };
  // Under parallel runs Vite's default HMR port is shared, so the injected client can
 // fail to open its socket. That is a test-harness artifact, not a page defect; any
 // other page error still fails the run.
 page.on('pageerror',e=>{if(!/WebSocket closed without opened/.test(e.message))errors.push(e.message);});
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),method=req.method();
   const send=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data,authenticated:true})});
   if(url.pathname==='/api/admin/auth/session')return send({authenticated:true,username:'test'});
   if(url.pathname==='/api/admin/social/lookup'){
    assert.equal(method,'POST');
    const body=req.postDataJSON();lookups.push(body);notifyLookup?.();notifyLookup=null;
    assert.deepEqual(Object.keys(body).sort(),['accountId','platform']);
    const success=()=>send({accountId:'canonical-'+body.accountId,accountName:'昵称-'+(body.platform==='weibo'?'':body.platform+'-')+body.accountId,profileUrl:'https://weibo.com/u/123',recognized:true,message:''});
    if(lookupMode==='hold'){heldLookups.set(body.platform+':'+body.accountId,success);return;}
    if(lookupMode==='error')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'平台暂不可用'})});
    if(lookupMode==='limited')return send({accountId:body.accountId,accountName:'',profileUrl:'',recognized:false,message:'平台限制需手填'});
    return success();
   }
   if(url.pathname==='/api/admin/social'){
    if(failRead)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({success:false,error:'测试读取失败'})});
    return send({accounts:rows,links:{}});
   }
   if(url.pathname==='/api/admin/pocket48/members'){
     rosterReads++;
     if(failRoster)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:'目录暂不可用'})});
     return send({list:[{memberId:'1001',memberName:'目录成员',groupName:'SNH48 · Team X',groupIds:['10:4']}],groups:[{groupId:'10:4',groupName:'SNH48 · Team X'}],next:null});
    }
    if((method==='POST'||method==='PUT')&&url.pathname.startsWith('/api/admin/social/accounts')){
     if(holdSave)await new Promise(r=>{releaseSave=r;});
     if(failSave)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({success:false,error:'主页链接与平台不匹配',field:'accountId'})});
    }
    if(method==='POST'){
    const body=req.postDataJSON();writes.push(body);rows.push({id:'testrow'+(++sequence),...body});
   }else if(method==='PUT'){
    const body=req.postDataJSON();writes.push(body);rows=rows.map(r=>r.id===url.pathname.split('/').at(-1)?{...r,...body}:r);
   }else if(method==='DELETE')rows=rows.filter(r=>r.id!==url.pathname.split('/').at(-1));
   return send({accounts:rows});
  });
  // First load pays Vite's cold transform of the whole module graph, which is
 // unrelated to what this test asserts; the per-action default timeout stays tight.
 await page.goto('http://127.0.0.1:'+server.address().port+'/admin/social',{timeout:60000,waitUntil:'domcontentloaded'});
  await page.getByText('还没有登记任何社交账号',{exact:true}).waitFor();
  assert.equal(await page.getByRole('navigation',{name:'管理导航'}).getByRole('link',{name:'成员社交账号',exact:true}).count(),1);
  const add=()=>page.getByRole('button',{name:'新增账号',exact:true}).first().click();
  const save=async()=>{await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});};
  const waitName=value=>page.waitForFunction(expected=>document.querySelector('#sa-account-name')?.value===expected,value);
  const triggerLookup=async(id)=>{
   const started=new Promise(resolve=>{notifyLookup=resolve;});
   await page.locator('#sa-account-id').fill(id);await page.locator('#sa-account-name').focus();await started;
  };
  const openAccountMenu=async(scope=page)=>{await scope.locator('.sa-card .sa-more > summary').first().click();};
  const cancel=async()=>{await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});};
  // Preview-like fixtures: account count must not change member width; long IDs
  // truncate without hiding the full title, and action menus work by keyboard/touch.
  const longId='MS4wLjAB'.repeat(25);
  rows=[
   {id:'layout1',memberName:'成员甲',platform:'weibo',accountName:'公开昵称',accountId:longId,profileUrl:'https://weibo.com/u/123'},
   {id:'layout2',memberName:'成员甲',platform:'group',accountId:'123456789',accountName:'',groupKind:'qq',note:'公开入群方式'},
   {id:'layout3',memberName:'成员乙',platform:'douyin',accountName:'另一个昵称',accountId:'456'},
   {id:'layout4',memberName:'成员丙',platform:'bilibili',accountName:'第三位昵称',accountId:'789'},
  ];
  // Reload re-pays Vite's cold transform; assert on the rendered result instead.
  await page.reload({timeout:60000,waitUntil:'domcontentloaded'});await page.locator('.sa-card').nth(3).waitFor();
  const desktopBoxes=await page.locator('.sa-member').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));
  assert.equal(desktopBoxes.length,3);
  assert.ok(Math.abs(desktopBoxes[0].width-desktopBoxes[1].width)<1,'multi-account and lone-account members have equal widths');
  assert.equal(desktopBoxes[0].y,desktopBoxes[1].y,'desktop is two columns');
  assert.ok(desktopBoxes[2].y>desktopBoxes[0].y,'third member starts a new row');
  assert.equal(desktopBoxes[2].x,desktopBoxes[0].x);
  const firstMember=page.locator('.sa-member').filter({has:page.getByRole('heading',{name:'成员甲',exact:true})});
  const rowBoxes=await firstMember.locator('.sa-card').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,height:r.height};}));
  assert.equal(rowBoxes[0].x,rowBoxes[1].x);
  assert.ok(rowBoxes[1].y>rowBoxes[0].y,'accounts stack vertically');
  assert.ok(rowBoxes[0].height<100,'simple account is a compact row, not a footer card');
  const secondary=firstMember.locator('.sa-account-secondary').first();
  assert.ok((await secondary.getAttribute('title')).includes(longId));
  assert.ok(await secondary.evaluate(e=>e.scrollWidth>e.clientWidth && getComputedStyle(e).textOverflow==='ellipsis'));
  const profile=page.getByRole('link',{name:'公开昵称',exact:true});
  assert.equal(await profile.getAttribute('href'),'https://weibo.com/u/123');
  assert.equal(await profile.getAttribute('rel'),'noopener noreferrer');
  assert.equal(await page.locator('.sa-avatar,.sa-card footer').count(),0);
  const firstMenu=firstMember.locator('.sa-card .sa-more').first(),summary=firstMenu.locator('summary');
  assert.equal(await firstMenu.getByRole('button',{name:'编辑',exact:true}).isVisible(),false);
  await summary.focus();await page.keyboard.press('Enter');
  await firstMenu.getByRole('button',{name:'编辑',exact:true}).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await firstMenu.getByRole('button',{name:'编辑',exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await firstMenu.getAttribute('open'),null);
  assert.equal(await summary.evaluate(e=>e===document.activeElement),true);
  await summary.click();await page.getByRole('heading',{name:'成员社交账号',exact:true}).click();
  assert.equal(await firstMenu.getAttribute('open'),null,'outside pointer dismisses the menu');
  await summary.click();await firstMenu.getByRole('button',{name:'删除 公开昵称',exact:true}).click();
  await page.getByRole('dialog').waitFor();assert.equal(rows.length,4,'delete still requires confirmation');
  await cancel();assert.equal(rows.length,4);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const mobileBoxes=await page.locator('.sa-member').evaluateAll(elements=>elements.map(e=>e.getBoundingClientRect().x));
  assert.equal(new Set(mobileBoxes).size,1,'mobile becomes a single column');
  assert.ok(await summary.evaluate(e=>e.getBoundingClientRect().height>=44),'touch menu has a full touch target');
  await summary.tap();await firstMenu.getByRole('button',{name:'编辑',exact:true}).tap();
  await page.getByRole('dialog').waitFor();await cancel();
  rows=[];writes.length=0;await page.setViewportSize({width:1440,height:1000});await page.reload({timeout:60000,waitUntil:'domcontentloaded'});
  await page.getByText('还没有登记任何社交账号',{exact:true}).waitFor();
  await add();
  // Stable input debounces, while blur starts immediately without duplicate requests.
  const beforeDebounce=lookups.length;
  await page.locator('#sa-account-id').fill('12');
  await page.locator('#sa-account-id').fill('123');
  assert.equal(lookups.length,beforeDebounce,'typing must not request on every keystroke');
  await waitName('昵称-123');
  assert.equal(lookups.length,beforeDebounce+1);
  await page.locator('#sa-account-name').focus();
  assert.equal(lookups.length,beforeDebounce+1,'blur must deduplicate a completed lookup');
  assert.equal(await page.locator('#sa-account-id').inputValue(),'123','lookup canonical ID must not rewrite the raw input');
  assert.equal(await page.locator('#sa-member').inputValue(),'','lookup must never assign a member');
  await page.locator('#sa-lookup-status').filter({hasText:'已读取昵称'}).waitFor();
  assert.equal(writes.length,0,'recognition is not persistence');
  await cancel();

  await add();const beforeIME=lookups.length;
  await page.locator('#sa-member').fill('输入法成员');
  await page.locator('#sa-account-id').dispatchEvent('compositionstart');
  await page.locator('#sa-account-id').fill('中文输入');
  await page.locator('#sa-account-id').dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true});
  // Deliberately cross the debounce window: composition must suppress lookup.
  await page.waitForTimeout(750);
  assert.equal(lookups.length,beforeIME);assert.equal(writes.length,0);
  await page.locator('#sa-account-id').dispatchEvent('compositionend');await waitName('昵称-中文输入');
  await cancel();

  lookupMode='error';await add();await triggerLookup('failed');
  await page.locator('#sa-lookup-status').filter({hasText:'昵称识别失败'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),true);
  lookupMode='success';await page.getByRole('button',{name:'重试识别',exact:true}).click();await waitName('昵称-failed');
  lookupMode='limited';await triggerLookup('limited');
  await page.locator('#sa-lookup-status').filter({hasText:'平台限制需手填'}).waitFor();
  await waitName('');await cancel();

  lookupMode='hold';await add();await triggerLookup('manual');
  await page.locator('#sa-account-name').fill('手填保护');await releaseLookup('manual');
  await page.locator('#sa-lookup-status').filter({hasText:'保留你填写的昵称'}).waitFor();await waitName('手填保护');
  await triggerLookup('manual-cleared');await page.locator('#sa-account-name').fill('');await releaseLookup('manual-cleared');
  await page.locator('#sa-lookup-status').filter({hasText:'保留你填写的昵称'}).waitFor();await waitName('');
  await cancel();
  await add();await triggerLookup('cross-platform');
  const platformStarted=new Promise(resolve=>{notifyLookup=resolve;});
  await page.getByRole('radio',{name:'B站',exact:true}).click();await platformStarted;
  await releaseLookup('cross-platform','bilibili');await waitName('昵称-bilibili-cross-platform');
  await releaseLookup('cross-platform');await waitName('昵称-bilibili-cross-platform');
  await cancel();
  await add();await triggerLookup('old-id');await triggerLookup('new-id');
  await releaseLookup('new-id');await waitName('昵称-new-id');
  await releaseLookup('old-id');await waitName('昵称-new-id');
  await triggerLookup('old-platform');
  await page.getByRole('radio',{name:'应援群',exact:true}).click();
  const beforeGroup=lookups.length;
  await page.locator('#sa-account-id').fill('群号');await page.locator('#sa-member').focus();
  await releaseLookup('old-platform');
  assert.equal(await page.locator('.sa-lookup-row').count(),0);
  assert.equal(lookups.length,beforeGroup,'groups must not invoke lookup');
  await cancel();
  await add();await triggerLookup('closed');await cancel();await add();
  await releaseLookup('closed');await waitName('');
  assert.equal(await page.locator('#sa-lookup-status').textContent(),'输入账号后自动读取昵称；可手填，也可留空保存。');
  // Saving with an in-flight lookup neither blocks nor requires a nickname.
  await triggerLookup('save-pending');await page.locator('#sa-member').fill('空昵称成员');await save();
  assert.equal(writes.at(-1).accountName,'');await releaseLookup('save-pending');
  rows=[];writes.length=0;await page.reload({timeout:60000,waitUntil:'domcontentloaded'});
  lookupMode='success';
  await add();
  await page.locator('#sa-member-options option[value="目录成员"]').waitFor({state:'attached'});
  assert.equal(await page.locator('#sa-member-options option[value="目录成员"]').getAttribute('label'),'SNH48 · Team X');
  await page.getByLabel('成员',{exact:true}).fill('目录成员');
  await page.getByRole('radio',{name:'微博',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio',{name:'小红书',exact:true}).getAttribute('aria-checked'),'true');
  await page.keyboard.press('Home');
  await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.getByLabel('成员',{exact:true}).fill('');
  await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();
  assert.equal(await page.locator('#sa-member').evaluate(e=>e===document.activeElement),true);
  assert.equal(writes.length,0);
  await page.getByLabel('成员',{exact:true}).fill('测试成员');
  await page.getByLabel('账号 ID / 主页链接',{exact:true}).fill(' https://weibo.com/u/1234567890?from=profile ');
  assert.equal(await page.getByRole('radiogroup',{name:'微博账号类型'}).count(),0);
  assert.equal(await page.getByRole('radio').count(),5);
  await page.getByLabel('备注（可选）',{exact:true}).fill('小号，偶尔更新日常');
   await page.getByLabel('备注（可选）',{exact:true}).press('Enter');
   assert.equal(writes.length,0,'textarea Enter must not submit');
   await page.getByLabel('备注（可选）',{exact:true}).fill('小号，偶尔更新日常');
   await page.getByLabel('账号 ID / 主页链接',{exact:true}).press('Enter');
   await page.getByRole('dialog').waitFor({state:'detached'});
   assert.equal(writes.at(-1).accountId,' https://weibo.com/u/1234567890?from=profile ','submit raw link without client parsing');
  assert.equal(writes.at(-1).size,'');
  assert.equal(writes.at(-1).note,'小号，偶尔更新日常');
  await page.locator('.sa-card-note').filter({hasText:'小号，偶尔更新日常'}).waitFor();
  assert.equal(await page.locator('.sa-stat').count(),3);
  assert.equal(await page.locator('.sa-tag-second,.sa-tag-main').count(),0);
  await openAccountMenu();await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('账号昵称（可选）',{exact:true}).fill('测试昵称');
   failSave=true;await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();
   await page.locator('#sa-save-error').waitFor();
   await page.waitForFunction(()=>document.activeElement?.id==='sa-account-id');
   assert.equal(await page.getByLabel('账号昵称（可选）',{exact:true}).inputValue(),'测试昵称');
   assert.equal(await page.locator('#sa-account-id').getAttribute('aria-invalid'),'true');
   failSave=false;holdSave=true;
   await page.getByLabel('账号 ID / 主页链接',{exact:true}).fill('1234567890');
   await page.getByLabel('账号 ID / 主页链接',{exact:true}).press('Enter');
   await page.getByRole('button',{name:'正在保存…',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);
   await page.waitForFunction(()=>document.querySelector('.sa-editor')?.getAttribute('aria-busy')==='true');
   assert.ok(releaseSave);releaseSave();holdSave=false;
   await page.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('.sa-card-name strong').filter({hasText:'测试昵称'}).waitFor();
  assert.equal(rows.length,1);
  await openAccountMenu();await page.getByRole('button',{name:'编辑',exact:true}).click();
  await triggerLookup('existing-name-check');
  await page.locator('#sa-lookup-status').filter({hasText:'保留你填写的昵称'}).waitFor();
  await waitName('测试昵称');await cancel();
  await add();
  await page.getByLabel('成员',{exact:true}).fill('测试成员');
  await page.getByRole('radio',{name:'应援群',exact:true}).click();
  await page.getByLabel('应援群类型',{exact:true}).selectOption('custom');
  await page.getByPlaceholder('填写群类型，例如「微博应援群」').fill('自定义应援群');
  await page.getByLabel('群名 / 群号',{exact:true}).fill('测试一群');
  await page.getByLabel('群人数（可选）',{exact:true}).fill('-1');
   await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();
   assert.equal(await page.locator('#sa-count').evaluate(e=>e===document.activeElement),true);
   await page.getByLabel('群人数（可选）',{exact:true}).fill('');
   await page.getByLabel('入群方式 / 备注',{exact:true}).fill('公开入群说明');await save();
  assert.equal(writes.at(-1).groupKind,'other:自定义应援群');assert.equal(writes.at(-1).memberCount,null);
  await page.getByRole('button',{name:'按平台',exact:true}).click();
  await page.locator('.sa-chip').filter({hasText:'应援群'}).click();
  assert.equal(await page.locator('.sa-platform').count(),1);
  assert.equal(await page.locator('.sa-card').count(),1);
  await page.getByRole('button',{name:'全部',exact:true}).click();
  await page.getByRole('button',{name:'按成员',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索账号'}).fill('测试昵称');
  assert.equal(await page.locator('.sa-card').count(),1);
  await openAccountMenu();await page.getByRole('button',{name:'删除 测试昵称',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(rows.length,1);
  await page.getByRole('searchbox',{name:'搜索账号'}).fill('');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'展开导航'}).click();
  await page.locator('aside.sidebar.open').waitFor();
  await page.getByRole('navigation',{name:'管理导航'}).getByRole('link',{name:'成员社交账号',exact:true}).click();
  await page.locator('aside.sidebar.open').waitFor({state:'detached'});
  failRoster=true;await add();
   await page.getByText('成员目录暂不可用，仍可手填或选择已登记成员。',{exact:false}).waitFor();
   assert.ok(await page.locator('#sa-member-options option[value="测试成员"]').count());
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.getByLabel('成员',{exact:true}).fill('自由手填成员');
   await page.getByLabel('账号 ID / 主页链接',{exact:true}).fill('newhandle');
   await save();
   const note='旧备注'.repeat(150);rows.find(r=>r.memberName==='自由手填成员').note=note;
   await page.reload({timeout:60000,waitUntil:'domcontentloaded'});await page.locator('.sa-card-note').filter({hasText:note}).waitFor();
   const freeMember=page.locator('.sa-member').filter({hasText:'自由手填成员'});await openAccountMenu(freeMember);await freeMember.getByRole('button',{name:'编辑',exact:true}).click();
   assert.equal(await page.getByLabel('备注（可选）',{exact:true}).inputValue(),note);
   assert.equal(await page.getByLabel('备注（可选）',{exact:true}).getAttribute('maxlength'),String(note.length));
   await save();assert.equal(writes.at(-1).note,note);
   await add();await page.getByRole('button',{name:'取消',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'detached'});
   await add();await page.getByRole('button',{name:'关闭',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'detached'});
   await add();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
   assert.ok(rosterReads>0);
   failRead=true;await page.reload({timeout:60000,waitUntil:'domcontentloaded'});await page.getByRole('alert').filter({hasText:'测试读取失败'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'新增账号',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[], 'page errors: ' + errors.join(' | '));
 }finally{
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await vite.close();
 }
});
