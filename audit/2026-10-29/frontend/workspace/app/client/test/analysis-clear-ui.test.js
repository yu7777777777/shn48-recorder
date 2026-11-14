import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
// Clearing is irreversible, so the browser test only proves the UI contract: it
// confirms first, sends confirmed=true, and shows the result instead of guessing.
async function fixture(t){const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'clear-ui-vite-'));const entry="import React from 'react';import {createRoot} from 'react-dom/client';import Panel from '/src/components/AnalysisPanel.jsx';import {MemoryRouter} from 'react-router-dom';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Panel,{id:'rec-clear',position:0})));";const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react-router-dom','axios']},plugins:[{name:'clear-test',resolveId(id){if(id==='/clear-test.js')return '\u0000clear-test';},load(id){if(id==='\u0000clear-test')return entry;}}]});const server=httpServer((req,res)=>{if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end("export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){}");return;}if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/clear-test.js"></script>');}else vite.middlewares(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(30000);return {page,url:'http://127.0.0.1:'+server.address().port};}
const analysed={segments:[{start:0,end:1.5,text:'大家好'},{start:1.5,end:3,text:'今天直播'}]};
const cleared={segments:[],chapters:[],highlights:[]};
test('clearing asks first, never fires without confirmation, and reports the empty result',async t=>{
 const {page,url}=await fixture(t);const deletes=[];let confirmedFlag=null;
 page.on('dialog',async dialog=>{await dialog.dismiss();});
 await page.route('**/api/**',async route=>{const request=route.request();if(request.method()==='DELETE'){await page.evaluate(()=>{}).catch(()=>{});deletes.push(1);confirmedFlag=(request.postDataJSON()||{}).confirmed===true;return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:cleared})});}return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:analysed})});});
 await page.goto(url);
 const button=page.getByRole('button',{name:'清空字幕与分析'});await button.waitFor();
 await button.click();
 await page.waitForTimeout(300);
 assert.equal(deletes.length,0,'dismissing the confirmation must not call the API');
 await page.unroute('**/api/**');
 page.removeAllListeners('dialog');page.on('dialog',async dialog=>{await dialog.accept();});
 await page.route('**/api/**',async route=>{const request=route.request();if(request.method()==='DELETE'){deletes.push(1);confirmedFlag=(request.postDataJSON()||{}).confirmed===true;return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:cleared})});}return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:analysed})});});
 await button.click();
 await page.getByText('已清空字幕与分析，可重新生成或导入新的字幕后重来。').waitFor();
 assert.equal(deletes.length,1);assert.equal(confirmedFlag,true,'the destructive request must carry explicit confirmation');
 await page.waitForTimeout(200);
 assert.equal(await page.getByRole('button',{name:'清空字幕与分析'}).count(),0,'nothing left to clear once the result is empty');
 assert.match(await page.getByRole('tab',{name:/字幕/}).innerText(),/0/);
});
test('an empty archive shows no clear action at all',async t=>{
 const {page,url}=await fixture(t);
 await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:cleared})}));
 await page.goto(url);
 await page.getByRole('tab',{name:/字幕/}).waitFor();
 assert.equal(await page.getByRole('button',{name:'清空字幕与分析'}).count(),0);
});
