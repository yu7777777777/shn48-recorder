import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createServer as httpServer} from 'node:http';
import {createServer as viteServer} from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));
const {chromium}=require('playwright');
const segments=[{start:5,end:9,text:'真实字幕零 <img src=x onerror=alert(1)>',en:'Real source zero'},{start:12,end:16,text:'真实字幕一',en:'Real source one'},{start:19,end:23,text:'无关字幕二'},{start:100,end:110,text:'不重叠字幕三'},{start:30,end:35,text:'边界字幕四'}];
const chapter={start:0,end:30,title:'章节标题',summary:'分析不是证据',evidenceIds:[0,1,1,-1,999,'2',1.5,3,4]};
const ready={segments,chapters:[chapter],highlights:[{...chapter,title:'精彩标题',evidenceIds:[1]}],summary:'已完成总结',job:{kind:'summarize',status:'done'}};

// A virtual Vite entry mounts only the actual component; it never changes application routes/files.
async function fixture(t){
 const entry= "import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Panel from '/src/components/AnalysisPanel.jsx';import '/src/index.css';const root=createRoot(document.getElementById('root'));window.media={current:document.createElement('video')};document.body.appendChild(window.media.current);window.mount=(id,audio=false)=>root.render(React.createElement(MemoryRouter,null,React.createElement(Panel,{id,audio,video:window.media,position:6})));window.mount('A');";
 const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-ui-vite-'));
 const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'analysis-test-entry',resolveId(id){if(id==='/analysis-test-entry.js')return '\0analysis-test-entry';},load(id){if(id==='\0analysis-test-entry')return entry;}}]});
 const server=httpServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/analysis-test-entry.js"></script>');}else vite.middlewares(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage();page.setDefaultTimeout(30000);
 return {page,url:'http://127.0.0.1:'+server.address().port,send:(route,data)=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})})};
}

test('analysis evidence is strict source-indexed, expandable, safe text and seekable in both tabs',async t=>{
 const {page,url,send}=await fixture(t);await page.route('**/api/**',r=>send(r,ready));await page.goto(url);
 await page.getByRole('tab',{name:'章节',exact:true}).click();
 const detail=page.locator('.analysis-evidence');assert.equal(await detail.getAttribute('open'),null);
 await detail.locator('summary').click();assert.equal(await detail.locator('li').count(),2);
 assert.match(await detail.innerText(),/真实字幕零 <img/);assert.doesNotMatch(await detail.innerText(),/无关字幕二|不重叠字幕三|边界字幕四/);assert.equal(await detail.locator('img').count(),0);
 await detail.getByRole('button',{name:'跳转原片字幕 1',exact:true}).click();assert.equal(await page.evaluate(()=>window.media.current.currentTime),12);
 await page.getByRole('tab',{name:'精彩片段',exact:true}).click();await page.locator('.analysis-evidence summary').click();assert.equal(await page.locator('.analysis-evidence li').count(),1);assert.match(await page.locator('.analysis-evidence').innerText(),/真实字幕一/);
 assert.equal(await page.getByRole('link',{name:'下载 Markdown 总结'}).getAttribute('href'),'/api/admin/analysis/A/summary?format=markdown');
 assert.equal(await page.getByRole('link',{name:'下载 JSON 分析'}).getAttribute('href'),'/api/admin/analysis/A/summary?format=json');
 assert.match(await page.locator('.analysis-disclosure').innerText(),/字符双限分块/);
});

test('legacy entries do not invent evidence; unfinished exports hidden and old success survives failure',async t=>{
 const {page,url,send}=await fixture(t);let value={segments,chapters:[{start:0,end:30,title:'旧章节',summary:'旧内容'}]};await page.route('**/api/**',r=>send(r,value));await page.goto(url);
 await page.getByRole('tab',{name:'章节',exact:true}).click();await page.locator('.analysis-evidence summary').click();assert.equal(await page.locator('.analysis-evidence li').count(),0);assert.match(await page.locator('.analysis-evidence').innerText(),/旧版分析/);
 assert.equal(await page.getByRole('link',{name:'下载 JSON 分析'}).count(),1);
 value={segments,chapters:[{...chapter,start:30,end:0}]};await page.evaluate(()=>window.mount('invalid-time'));await page.getByRole('tab',{name:'章节',exact:true}).click();await page.locator('.analysis-evidence summary').click();assert.equal(await page.locator('.analysis-evidence li').count(),0);
 value={segments,chapters:[],highlights:[],job:{kind:'summarize',status:'running'}};await page.evaluate(()=>window.mount('B'));await page.getByRole('button',{name:'取消任务',exact:true}).waitFor();assert.equal(await page.locator('.analysis-exports').count(),0);
 value={...ready,job:{kind:'summarize',status:'running'}};await page.evaluate(()=>window.mount('C'));await page.locator('.analysis-retained-summary').waitFor();assert.equal(await page.locator('.analysis-exports').count(),0);
 value={...ready,job:{kind:'summarize',status:'failed'}};await page.evaluate(()=>window.mount('D'));await page.getByRole('link',{name:'下载 JSON 分析'}).waitFor();assert.match(await page.locator('.analysis-retained-summary').innerText(),/仍可下载/);
});

test('bilingual native WebVTT contains both languages and archive switch clears old UI and delayed responses',async t=>{
 const {page,url,send}=await fixture(t);let held,release;const waiting=new Promise(r=>release=r);await page.route('**/api/**',async r=>{const id=new URL(r.request().url()).pathname.split('/').pop();if(id==='slow'){held=true;await waiting;return send(r,{...ready,summary:'过期摘要',segments:[{start:0,end:99,text:'过期字幕'}]});}return send(r,id==='empty'?{}:ready);});
 await page.goto(url);await page.locator('.analysis-line').first().waitFor();
 await page.evaluate(()=>{const element=document.createElement('video');document.body.appendChild(element);window.media.current=element;window.mount('native');});
 await page.getByLabel('字幕语言').selectOption('bilingual');
 const cue=await page.evaluate(async()=>await(await fetch(document.querySelector('video track').src)).text());assert.match(cue,/真实字幕零 <img/);assert.match(cue,/Real source zero/);assert.equal(await page.locator('video track').getAttribute('label'),'双语字幕');
 await page.getByLabel('搜索字幕').fill('zero');await page.evaluate(()=>window.mount('slow'));
 await page.waitForFunction(()=>document.querySelector('input[aria-label="搜索字幕"]').value==='');
 // wait for request interception without an arbitrary browser delay
 while(!held)await new Promise(r=>setImmediate(r));
 assert.equal(await page.locator('.analysis-exports').count(),0);assert.equal(await page.locator('.analysis-line').count(),0);
 await page.evaluate(()=>window.mount('empty'));await page.getByText('还没有字幕。可直接导入 SRT，或配置识别服务后生成字幕。').waitFor();release();
 await page.waitForResponse(r=>r.url().endsWith('/analysis/slow'));assert.equal(await page.getByText('过期字幕',{exact:true}).count(),0);assert.equal(await page.locator('.analysis-exports').count(),0);assert.equal(await page.locator('video track').count(),0);
});

test('late task responses cannot add jobs or errors to a different archive',async t=>{
 const {page,url,send}=await fixture(t);let release;const hold=new Promise(r=>release=r);
 await page.route('**/api/**',async r=>{if(r.request().method()==='POST'){await hold;return send(r,{kind:'summarize',status:'running',phase:'旧归档任务'});}return send(r,r.request().url().endsWith('/A')?ready:{});});
 await page.goto(url);await page.locator('.analysis-line').first().waitFor();
 const posted=page.waitForRequest(r=>r.method()==='POST');await page.getByRole('button',{name:'生成章节与精彩片段',exact:true}).click();await posted;
 await page.evaluate(()=>window.mount('empty'));await page.getByText('还没有字幕。可直接导入 SRT，或配置识别服务后生成字幕。').waitFor();
 const replied=page.waitForResponse(r=>r.request().method()==='POST');release();await replied;
 assert.equal(await page.getByRole('button',{name:'取消任务',exact:true}).count(),0);assert.equal(await page.getByText('旧归档任务',{exact:false}).count(),0);assert.equal(await page.locator('.analysis-exports').count(),0);
});
