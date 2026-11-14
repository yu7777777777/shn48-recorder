import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
// The app's pages rely on the automatic JSX runtime from @vitejs/plugin-react, so the
// fixture must load that plugin instead of an esbuild default.
// Resolve from the client package, not from the server package used above.
const clientRequire=createRequire(new URL('../package.json',import.meta.url));const reactPlugin=clientRequire('@vitejs/plugin-react');
async function fixture(t,languages=['zh-CN','zh']){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'public-summary-vite-'));// The page reads a build-time global; the fixture must define it before the module
// graph loads, the same way the production config does.
const entry=`Object.defineProperty(navigator,'languages',{get:()=>${JSON.stringify(languages)}});window.__APP_VERSION__='test';import React from 'react';import {createRoot} from 'react-dom/client';import Page from '/src/pages/PublicReplay.jsx';import {MemoryRouter,Route,Routes} from 'react-router-dom';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/replays/777']},React.createElement(Routes,null,React.createElement(Route,{path:'/replays/:replayId',element:React.createElement(Page)}))));`;const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react-router-dom','axios']},// __APP_VERSION__ is substituted per module by the app's own Vite config; the
 // standalone fixture must do the same or the page throws before rendering.
define:{__APP_VERSION__:JSON.stringify('test')},plugins:[reactPlugin(),{name:'ps-test',resolveId(id){if(id==='/ps-test.js')return '\u0000ps-test';},load(id){if(id==='\u0000ps-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end('export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}');return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/ps-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));return {page,pageErrors,url:'http://127.0.0.1:'+server.address().port};}
// The page follows the browser language; pin these assertions to the Chinese copy.
const detail={replayId:'777',title:'测试回放',memberName:'成员',startedAt:new Date('2026-10-01T12:00:00Z').toISOString()};
test('a published summary appears under the replay and never shows model or subtitle text',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.route('**/api/public/**',route=>{
  const u=route.request().url();
  if(u.endsWith('/summary'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{recordingId:'rec-1',summary:'这是公开总结',chapters:[{start:0,end:60,title:'开场',summary:'开场内容'}],highlights:[]}})});
  if(u.endsWith('/play'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{protocol:'hls',playUrl:'/api/public/replay-streams/t/manifest'}})});
  if(u.endsWith('/health'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{ok:true}})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{replay:detail}})});
 });
 await page.goto(url);
 const card=page.locator('.public-replay-summary');
 try { try { await card.waitFor({timeout:20000}); } catch (e) { throw new Error('summary card missing; page errors: ' + JSON.stringify(pageErrors)); } } catch (error) { const body=await page.locator('body').innerText(); throw new Error('summary card missing; errors=' + JSON.stringify(pageErrors) + '; body=' + body.slice(0,600)); }
 assert.deepEqual(pageErrors,[], "the page renders without errors: " + pageErrors.join(" | "));
 assert.equal(await page.getByRole('button',{ name: /复制回放链接/ }).count(),1,'exactly one share button is rendered');
 const text=await card.innerText();
 assert.match(text,/内容总结/);assert.match(text,/这是公开总结/);assert.match(text,/开场/);assert.match(text,/AI 生成，仅供参考/);
 assert.equal(text.includes('sk-'),false);assert.equal(text.includes('ai.example.com'),false,'no model or endpoint is shown to visitors');
});
test('an unpublished summary shows nothing at all instead of an empty panel',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/public/**',route=>{
  const u=route.request().url();
  if(u.endsWith('/summary'))return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({success:false,error:'Replay summary is unavailable'})});
  if(u.endsWith('/play'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{protocol:'hls',playUrl:'/api/public/replay-streams/t/manifest'}})});
  if(u.endsWith('/health'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{ok:true}})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{replay:detail}})});
 });
 await page.goto(url);
 await page.waitForTimeout(1500);
 assert.equal(await page.locator('.public-replay-summary').count(),0,'no empty summary card');
 assert.equal((await page.locator('body').innerText()).includes('Replay summary is unavailable'),false,'the failure message is not surfaced to visitors');
});
test('chapters-only mode shows the titles and says plainly that the prose is withheld',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.route('**/api/public/**',route=>{
  const u=route.request().url();
  if(u.endsWith('/summary'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{recordingId:'rec-1',detail:'chapters',summary:'',chapters:[{start:0,end:60,title:'开场',summary:'开场内容'}],highlights:[]}})});
  if(u.endsWith('/play'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{protocol:'hls',playUrl:'/api/public/replay-streams/t/manifest'}})});
  if(u.endsWith('/health'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{ok:true}})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{replay:detail}})});
 });
 await page.goto(url);
 const card=page.locator('.public-replay-summary');
 await card.waitFor({timeout:20000});
 const text=await card.innerText();
 assert.match(text,/只公开章节与时间/);
 assert.match(text,/开场/);
 assert.equal(text.includes('undefined'),false);
 assert.deepEqual(pageErrors,[]);
});
 