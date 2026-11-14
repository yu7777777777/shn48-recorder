import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-ui-vite-'));const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Setup from '/src/pages/AnalysisSettings.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Setup));";const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'health-test',resolveId(id){if(id==='/health-test.js')return '\u0000health-test';},load(id){if(id==='\u0000health-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end("export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}");return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/health-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);return {page,url:'http://127.0.0.1:'+server.address().port};}
const settings={asr:{url:'',model:'whisper-1',configured:false},ai:{url:'',model:'',configured:false},typesafe:{configured:false},glossary:[],offline:{enabled:false,model:'tiny'},queue:{autoRetry:false,maxRetries:3,resumeInterrupted:false}};
const queue=(health)=>({state:'idle',owned:true,queued:0,running:0,error:null,localOnly:true,health});
test('queue health explains parked work instead of hiding it',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>{const u=route.request().url();const body=u.endsWith('/analysis/queue')?queue({localOnly:true,policy:{autoRetry:false,resumeInterrupted:false,maxRetries:3},queued:3,running:1,done:7,failed:2,blockedByDisallowedPolicy:2,dormantRetries:1,nextWakeAt:'2026-01-01T05:00:00.000Z',recoveredLastStart:1,interruptedLastStart:2}):settings;route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:body})});});
 await page.goto(url);
 const list=page.getByRole('list',{name:'队列健康统计'});await list.waitFor();
 const text=await list.innerText();
 assert.match(text,/完成 7 · 失败 2 · 执行中 1 · 等待 3/);
 assert.match(text,/有 2 项在等待已关闭的自动重试或中断恢复开关/);
 assert.match(text,/最早的计划重试：.*共 1 项/);
 assert.match(text,/上次启动恢复了 1 项/);
 assert.match(text,/有 2 项被中断且未自动恢复/);
});
test('a healthy queue shows counts only, with no alarming filler',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>{const u=route.request().url();const body=u.endsWith('/analysis/queue')?queue({localOnly:true,policy:{autoRetry:false,resumeInterrupted:false,maxRetries:3},queued:0,running:0,done:4,failed:0,blockedByDisallowedPolicy:0,dormantRetries:0,nextWakeAt:null,recoveredLastStart:0,interruptedLastStart:0}):settings;route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:body})});});
 await page.goto(url);
 const list=page.getByRole('list',{name:'队列健康统计'});await list.waitFor();
 assert.match(await list.innerText(),/完成 4 · 失败 0 · 执行中 0 · 等待 0/);
 assert.equal(await list.locator('li').count(),1,'nothing to warn about when the queue is clean');
});
test('an older server without health data still renders',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>{const u=route.request().url();const body=u.endsWith('/analysis/queue')?{state:'idle',owned:true,queued:0,running:0,localOnly:true}:settings;route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:body})});});
 await page.goto(url);
 await page.getByText('分析队列：').waitFor();
 assert.equal(await page.getByRole('list',{name:'队列健康统计'}).count(),0,'no fabricated statistics');
});
