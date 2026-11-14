import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-ui-vite-'));const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Batch from '/src/components/AnalysisProvenanceBatch.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Batch,{ids:['rec-a','rec-b']}));";const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'batch-test',resolveId(id){if(id==='/batch-test.js')return '\u0000batch-test';},load(id){if(id==='\u0000batch-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end("export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}");return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/batch-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);return {page,url:'http://127.0.0.1:'+server.address().port};}
const body = (entries) => JSON.stringify({schemaVersion:1,exportedAt:'2026-01-03T00:00:00.000Z',count:entries.length,recordings:entries});
test('a batch audit lists every recording and never hides an unreadable one',async t=>{
 const {page,url}=await fixture(t);let payload=null;
 await page.route('**/api/**',async route=>{payload=route.request().postDataJSON();route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{schemaVersion:1,exportedAt:'2026-01-03T00:00:00.000Z',count:2,recordings:[{recordingId:'rec-a',provenance:{stages:[{stage:'summarize',status:'recorded',provider:'ai.example.com'}]}},{recordingId:'',error:'无法读取这条归档'}]}})});});
 await page.goto(url);
 await page.getByRole('button',{name:'生成整批来源清单'}).click();
 const table=page.getByRole('table',{name:'整批来源清单'});await table.waitFor();
 assert.deepEqual(payload.ids,['rec-a','rec-b'],'the component sends exactly the ids it was given');
 const rows=table.locator('tbody tr');
 // One row per stage for the readable archive, plus a dedicated error row.
 assert.equal(await rows.count(),5,'every stage and the failed entry stay visible');
 assert.match(await rows.nth(0).innerText(),/rec-a[\s\S]*语音识别[\s\S]*缺少记录/,'stages the server did not report are shown as missing');
 assert.match(await rows.nth(3).innerText(),/rec-a[\s\S]*总结[\s\S]*已记录[\s\S]*ai\.example\.com/,'the recorded stage keeps its host-only provider');
 assert.match(await rows.nth(4).innerText(),/未识别编号[\s\S]*无法读取这条归档/);
 assert.match(await page.getByRole('status').innerText(),/2 条归档/);
 assert.equal(await page.getByRole('button',{name:'下载表格（CSV）'}).count(),1,'a spreadsheet export is offered once the batch exists');
});
test('batch failures show the server reason instead of an empty table',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({success:false,error:'一次最多导出 50 条归档的来源清单'})}));
 await page.goto(url);
 await page.getByRole('button',{name:'生成整批来源清单'}).click();
 await page.getByRole('alert').waitFor();
 assert.match(await page.getByRole('alert').innerText(),/一次最多导出 50 条/);
 assert.equal(await page.getByRole('table',{name:'整批来源清单'}).count(),0);
});
