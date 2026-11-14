import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');const clientRequire=createRequire(new URL('../package.json',import.meta.url));const reactPlugin=clientRequire('@vitejs/plugin-react');
const entry="window.__APP_VERSION__='test';import React from 'react';import {createRoot} from 'react-dom/client';import Page from '/src/pages/PublicSocial.jsx';import {MemoryRouter,Route,Routes} from 'react-router-dom';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/s/CODE1234567890123456']},React.createElement(Routes,null,React.createElement(Route,{path:'/s/:code',element:React.createElement(Page)}))));";
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'psocial-vite-'));const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react-router-dom','axios']},define:{__APP_VERSION__:JSON.stringify('test')},plugins:[reactPlugin(),{name:'psocial',resolveId(id){if(id==='/psocial.js')return '\u0000psocial';},load(id){if(id==='\u0000psocial')return entry;}}]});const server=httpServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/psocial.js"></script>');return;}if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end('export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}');return;}vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close()}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const pg=await browser.newPage();pg.setDefaultTimeout(30000);const pageErrors=[];pg.on('pageerror',e=>pageErrors.push(e.message));return {page:pg,pageErrors,url:'http://127.0.0.1:'+server.address().port};}
test('a valid code opens a readable member page with links and no notes',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 const seen=[];
 await page.route('**/api/public/**',route=>{seen.push(route.request().url());return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{memberName:'成员甲',accounts:[{platform:'weibo',accountId:'12345',accountName:'昵称甲',groupKind:'',profileUrl:'https://weibo.com/12345'},{platform:'group',accountId:'群号',accountName:'粉丝群',groupKind:'qq',profileUrl:''}]}})});});
 await page.goto(url);
 await page.getByRole('heading',{name:/成员甲/}).waitFor();
 assert.equal(seen.length,1);
 // Every page load also produces a trailing empty request, so assert on the
 // request that actually carries the code rather than on the array order.
 assert.equal(seen.some(u=>u.endsWith('/api/public/social/CODE1234567890123456')),true,seen.join(' | '));
 const text=await page.locator('body').innerText();
 assert.match(text,/12345/);assert.match(text,/QQ群/);
 assert.equal(await page.getByRole('link',{name:'打开主页'}).count(),1,'only the account with a URL gets a link');
 assert.equal(text.includes('私有备注'),false);
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
test('an expired or unknown code shows the same neutral message with no data',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.route('**/api/public/**',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({success:false,error:'邀请链接无效或已过期'})}));
 await page.goto(url);
 await page.getByText('邀请链接无效或已过期').first().waitFor();
 const text=await page.locator('body').innerText();
 assert.equal(text.includes('成员'),false,'no member name leaks on failure');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
test('an English browser gets English copy and an English failure message',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }));
 await page.route('**/api/public/**',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({success:false,error:'邀请链接无效或已过期'})}));
 await page.goto(url);
 await page.getByText('This invite link is invalid or has expired').first().waitFor();
 const text=await page.locator('body').innerText();
 assert.equal(text.includes('邀请链接无效'),false,'the English visitor does not get Chinese copy');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
