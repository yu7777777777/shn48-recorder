import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
// The source harness does not need HMR: serve a no-socket Vite client while preserving CSS.
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'provenance-ui-vite-'));const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Provenance from '/src/components/AnalysisProvenance.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Provenance,{id:'rec-1'}));";const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'queue-test',resolveId(id){if(id==='/queue-test.js')return '\0queue-test';},load(id){if(id==='\0queue-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end("export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(id,css){let s=document.getElementById(id);if(!s){s=document.createElement('style');s.id=id;document.head.appendChild(s);}s.textContent=css;}export function removeStyle(id){document.getElementById(id)?.remove();}");return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/queue-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);return {page,url:'http://127.0.0.1:'+server.address().port,send:(route,data)=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})})};}

const provenance=(overrides={})=>({schemaVersion:1,exportedAt:'2026-01-03T00:00:00.000Z',recordingId:'rec-1',segments:12,glossary:7,english:{segments:12,recorded:5},stages:[
 {stage:'transcribe',status:'recorded',missing:[],fingerprint:'fp',completedAt:'2026-01-01T00:00:00.000Z'},
 {stage:'correct',status:'recorded',missing:[],provider:'ai.example.com',model:'corr-model',completedAt:'2026-01-01T01:00:00.000Z'},
 {stage:'translate',status:'partial',missing:[],model:'tr-model'},
 {stage:'summarize',status:'absent',missing:['provider','model','completedAt'],provider:null}
],...overrides});
test('provenance stays collapsed until asked, then reports each stage honestly',async t=>{const {page,url,send}=await fixture(t);let calls=0;
 await page.route('**/api/**',async route=>{calls++;await send(route,provenance());});
 await page.goto(url);
 const toggle=page.getByRole('button',{name:'展开查看'});
 await toggle.waitFor();
 assert.equal(await page.locator('table').count(),0,'nothing is fetched or rendered before the user asks');
 await toggle.click();
 const table=page.getByRole('table');
 await table.waitFor();
 assert.match(await page.getByRole('caption').innerText(),/12 条字幕.*5 条带翻译来源记录.*词库 7 条/);
 const rows=table.locator('tbody tr');
 assert.equal(await rows.count(),4);
 assert.match(await rows.nth(0).innerText(),/语音识别[\s\S]*已记录[\s\S]*未记录模型（指纹 fp）/);
 assert.match(await rows.nth(2).innerText(),/英文翻译[\s\S]*信息不全[\s\S]*tr-model/);
 assert.match(await rows.nth(3).innerText(),/总结[\s\S]*缺少记录[\s\S]*provider、model、completedAt/);
 // The provider cell names the service without echoing a URL, path or key.
 assert.match(await rows.nth(1).innerText(),/纠错[\s\S]*ai\.example\.com[\s\S]*corr-model/);
 assert.match(await rows.nth(0).innerText(),/语音识别[\s\S]*—[\s\S]*未记录模型/, 'a stage with no recorded host shows a dash, not a guess');
 assert.equal(await page.getByRole('link',{name:'下载来源清单 JSON'}).getAttribute('href'),'/api/admin/analysis/rec-1/provenance');
 assert.equal(await page.getByRole('link',{name:'下载可读版 Markdown'}).getAttribute('href'),'/api/admin/analysis/rec-1/provenance?format=markdown','the readable export is a separate, explicit choice');
 assert.equal(calls,1);
 await page.getByRole('button',{name:'收起'}).click();
 assert.equal(await table.count(),0);
 await page.getByRole('button',{name:'查看详情'}).click();
 await table.waitFor();assert.equal(calls,1,'reopening reuses the loaded record');
});
test('a failed load shows the reason and retries without inventing data',async t=>{const {page,url}=await fixture(t);let calls=0;
 await page.route('**/api/**',async route=>{calls++;if(calls===1)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({success:false,error:'读取失败'})});return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:provenance()})});});
 await page.goto(url);
 await page.getByRole('button',{name:'展开查看'}).click();
 const alert=page.getByRole('alert');await alert.waitFor();
 assert.match(await alert.innerText(),/读取失败/);
 assert.equal(await page.locator('table').count(),0,'no table is rendered from a failed request');
 await page.getByRole('button',{name:'重试'}).click();
 await page.getByRole('table').waitFor();
 assert.equal(calls,2);
});
