import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createServer as httpServer} from 'node:http';import {createServer as viteServer} from 'vite';
const require=createRequire(new URL('../../server/package.json',import.meta.url));const {chromium}=require('playwright');
const clientRequire=createRequire(new URL('../package.json',import.meta.url));const reactPlugin=clientRequire('@vitejs/plugin-react');
// The fixture mounts a tiny component that only talks to the hook, so the test
// pins the hook contract itself rather than whatever page happens to use it.
// Markup stays a plain div so the assertions read the layout value directly.
const entry="window.__APP_VERSION__='test';import React from 'react';import {createRoot} from 'react-dom/client';import useReplayLayout from '/src/hooks/useReplayLayout.js';"
 +"function Probe(){const {layout,setLayout,toggle}=useReplayLayout();return React.createElement('div',null,"
 +"React.createElement('p',{'data-testid':'layout'},layout),"
 +"React.createElement('button',{'data-testid':'toggle',onClick:toggle},'toggle'),"
 +"React.createElement('button',{'data-testid':'set-landscape',onClick:()=>setLayout('landscape')},'landscape'),"
 +"React.createElement('button',{'data-testid':'set-bogus',onClick:()=>setLayout('sideways')},'bogus'),"
 +"React.createElement('span',{'data-layout':layout,className:'replay-layout-'+layout},layout));}"
 +"createRoot(document.getElementById('root')).render(React.createElement(Probe));";
async function fixture(t){
 const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-layout-vite-'));
 const vite=await viteServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client']},define:{__APP_VERSION__:JSON.stringify('test')},plugins:[reactPlugin(),{name:'replay-layout',resolveId(id){if(id==='/replay-layout.js')return '\u0000replay-layout';},load(id){if(id==='\u0000replay-layout')return entry;}}]});
 const server=httpServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/replay-layout.js"></script>');return;}if(req.url?.startsWith('/@vite/client')){res.setHeader('Content-Type','application/javascript');res.end('export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},send(){},invalidate(){}});export function updateStyle(){}export function removeStyle(){} ');return;}vite.middlewares(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 t.after(async()=>{try{await browser?.close()}finally{await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(cacheDir,{recursive:true,force:true});}});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage();page.setDefaultTimeout(30000);
 const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 return {page,pageErrors,url:'http://127.0.0.1:'+server.address().port};
}
const KEY='snh48.replay.layout';
const layoutOf=(page)=>page.getByTestId('layout').innerText();
const stored=(page)=>page.evaluate((key)=>window.localStorage.getItem(key),KEY);

test('the first visit is portrait and writes nothing to storage',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 assert.equal(await layoutOf(page),'portrait');
 assert.equal(await stored(page),null,'a default visit must not pin a preference');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});

test('toggle flips to landscape and persists it',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 await page.getByTestId('toggle').click();
 await page.waitForFunction((key)=>window.localStorage.getItem(key)==='landscape',KEY);
 assert.equal(await layoutOf(page),'landscape');
 assert.equal(await stored(page),'landscape');
 assert.equal(await page.getByTestId('layout').getAttribute('data-testid'),'layout');
 assert.equal(await page.locator('.replay-layout-landscape').count(),1,'the layout drives the container class');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});

test('a reload restores the stored landscape choice',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 await page.getByTestId('toggle').click();
 await page.waitForFunction((key)=>window.localStorage.getItem(key)==='landscape',KEY);
 await page.reload();
 await page.getByTestId('layout').waitFor();
 assert.equal(await layoutOf(page),'landscape');
 await page.getByTestId('toggle').click();
 await page.waitForFunction((key)=>window.localStorage.getItem(key)==='portrait',KEY);
 await page.reload();
 await page.getByTestId('layout').waitFor();
 assert.equal(await layoutOf(page),'portrait','the way back is restored too');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});

test('setLayout accepts a value, persists it and rejects anything unknown',async t=>{
 const {page,url}=await fixture(t);
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 await page.getByTestId('set-landscape').click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="layout"]').textContent==='landscape');
 assert.equal(await stored(page),'landscape','setLayout persists the value it accepted');
 await page.getByTestId('set-bogus').click();
 // The rejected value must not reach storage and must not blank the layout.
 await page.waitForTimeout(200);
 assert.equal(await layoutOf(page),'portrait','an unknown value falls back to the default instead of blanking the page');
 assert.equal(await stored(page),'portrait','the default is what gets persisted, never the unknown string');
});

test('a stored value from an older build is ignored instead of trusted',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 await page.addInitScript(([key])=>{try{window.localStorage.setItem(key,'grid-mode')}catch{}},[KEY]);
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 assert.equal(await layoutOf(page),'portrait');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});

test('a read-only storage does not break the page',async t=>{
 const {page,pageErrors,url}=await fixture(t);
 // Safari private mode and some embedded webviews throw on every access.
 await page.addInitScript(()=>{const fail=()=>{throw new DOMException('denied','SecurityError')};Object.defineProperty(window,'localStorage',{configurable:true,get:fail});});
 await page.goto(url);
 await page.getByTestId('layout').waitFor();
 assert.equal(await layoutOf(page),'portrait','a blocked storage falls back to the default');
 await page.getByTestId('toggle').click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="layout"]').textContent==='landscape');
 assert.deepEqual(pageErrors,[],pageErrors.join(' | '));
});
