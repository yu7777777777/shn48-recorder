import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-tr-vite-'));const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Panel from '/src/components/AnalysisPanel.jsx';import {MemoryRouter} from 'react-router-dom';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Panel,{id:'rec-tr'})));";const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'tr-test',resolveId(id){if(id==='/tr-test.js')return '\u0000tr-test';},load(id){if(id==='\u0000tr-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end("export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}　");return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/tr-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);return {page,url:'http://127.0.0.1:'+server.address().port};}
const analysis={segments:[{start:0,end:2,text:'第一句',en:'First',enJA:'最初'},{start:2,end:4,text:'第二句',en:'Second'}],summary:'概述',chapters:[{start:0,end:4,title:'开场',summary:'开场内容',evidenceIds:[0,1]}],highlights:[]};
test('evidence quotes the translations a reader actually needs',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:analysis})}));
 await page.goto(url);
 await page.getByRole('tab',{name:/章节/}).click();
 await page.locator('summary',{hasText:'查看字幕证据'}).click();
 const items=page.locator('.analysis-evidence li');
 assert.equal(await items.count(),2);
 assert.match(await items.nth(0).innerText(),/第一句[\s\S]*英文：First[\s\S]*日文：最初/);
 const second=await items.nth(1).innerText();
 assert.match(second,/第二句[\s\S]*英文：Second/);
 assert.equal(second.includes('日文：'),false,'a line without Japanese shows no empty label');
});
