import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../server/package.json',import.meta.url));
const express=require('express'),{chromium}=require('playwright');
test('retired tools leave no menu links and old bookmarks redirect safely',async()=>{
 const app=express(),dist=fileURLToPath(new URL('../dist/',import.meta.url));
 app.use(express.static(dist));app.get('*',(_,res)=>res.sendFile(dist+'index.html'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,authenticated:true,data:{authenticated:true,groups:[],followedCount:0,totalCount:0}})}));
  // Optional live-origin check uses deployed assets; API mocks exercise navigation only.
  const url=process.env.UI_BASE_URL||'http://127.0.0.1:'+server.address().port;
  await page.goto(url+'/admin/cover-settings');await page.waitForURL('**/admin/archive');
  const nav=page.getByRole('navigation',{name:'管理导航'});
  assert.equal(await nav.getByRole('link',{name:'封面设置',exact:true}).count(),0);
  assert.equal(await nav.getByRole('link',{name:'房间上麦',exact:true}).count(),0);
  await nav.getByRole('link',{name:'字幕与 AI',exact:true}).waitFor();
  for(const name of ['B站草稿','系统设置','账户安全'])assert.equal(await nav.getByRole('link',{name,exact:true}).count(),1);
  assert.equal(await page.locator('a[href="/admin/cover-settings"]').count(),0);
  await page.goto(url+'/admin/room-voice');await page.waitForURL('**/admin/pocket48');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'展开导航'}).click();
  await nav.getByRole('link',{name:'口袋48',exact:true}).waitFor({state:'visible'});
  assert.equal(await nav.getByRole('link',{name:'房间上麦',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
