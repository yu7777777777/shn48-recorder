import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');const clientRequire=createRequire(new URL('../package.json',import.meta.url));const reactPlugin=clientRequire('@vitejs/plugin-react');
async function render(t,languages){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'dash-vite-'));const init=Array.isArray(languages)?`Object.defineProperty(navigator,'languages',{get:()=>${JSON.stringify(languages)}});`:'';const entry=`${init}window.__APP_VERSION__='test';import React from 'react';import {createRoot} from 'react-dom/client';import Page from '/src/pages/Dashboard.jsx';import {MemoryRouter} from 'react-router-dom';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Page)));`;const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react-router-dom','axios']},define:{__APP_VERSION__:JSON.stringify('test')},plugins:[reactPlugin(),{name:'dash',resolveId(id){if(id==='/dash.js')return '\u0000dash';},load(id){if(id==='\u0000dash')return entry;}}]});const server=httpServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/dash.js"></script>');return;}if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end('export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}');return;}vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close()}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{}})}) );return {page,pageErrors,url:'http://127.0.0.1:'+server.address().port};}
test('the overview renders Chinese copy for a Chinese browser',async t=>{
 const {page,pageErrors,url}=await render(t,['zh-CN','zh']);
 await page.goto(url);
 await page.getByRole('heading',{name:'系统总览'}).waitFor();
 const text=await page.locator('body').innerText();
 assert.match(text,/直播发现/);assert.match(text,/最近归档录像/);assert.equal(text.includes('Overview'),false);
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
test('the overview renders English copy for an English browser',async t=>{
 const {page,pageErrors,url}=await render(t,['en-US','en']);
 await page.goto(url);
 await page.getByRole('heading',{name:'Overview'}).waitFor();
 const text=await page.locator('body').innerText();
 assert.match(text,/Recent archives/);assert.equal(text.includes('系统总览'),false);
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
