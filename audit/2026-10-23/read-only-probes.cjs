"use strict";
// Audit-only probes. Do not repair application files or start production jobs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../../app');
const req = createRequire(path.join(root, 'server/package.json'));
const mode = process.argv[2] || 'offline';
async function offline() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shn48-audit-'));
  for (const name of ['DATA_DIR','POCKET48_DATA_DIR','RECORDINGS_DIR','COVERS_DIR']) process.env[name] = temp;
  process.env.CONFIG_PATH = path.join(temp, 'no-config.yaml');
  const manager=req('./modules/recorder/manager');
  const settings=req('./modules/analysis/settings');
  const service=req('./modules/analysis/service');
  // Pure in-memory fixtures; no account, network transport or model is used.
  manager.getRecordings=()=>[{id:'audit-fixture',liveId:'900009',source:'pocket48',mediaType:'video',status:'done',title:'Fixture'}];
  settings.get=()=>({publish:{summary:true,chapters:true,highlights:true},publicDetail:{mode:'chapters'}});
  service.result=()=>({summary:'HIDDEN_FULL_SUMMARY_AUDIT_MARKER',chapters:[{start:0,end:10,title:'Allowed title',summary:'chapter caption'}],highlights:[]});
  const app=req('./index').createApp();
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const api=await (await fetch(base+'/api/public/replays/900009/summary')).json();
    const html=await (await fetch(base+'/replays/900009')).text();
    console.log(JSON.stringify({probe:'chapters-only-share-preview',apiDetail:api.data.detail,apiSummary:api.data.summary,htmlLeaksHiddenSummary:html.includes('HIDDEN_FULL_SUMMARY_AUDIT_MARKER'),ogDescription:html.match(/<meta property="og:description"[^>]*>/)?.[0]},null,2));
    const route=req('./routes/public');
    const layer=route.stack.find(l=>l.route?.path==='/live' && l.route.methods.get);
    const live=req('./modules/pocket48/live');
    const original=live.listLives; live.listLives=async()=>{throw Error('mock upstream HTTP 503');};
    let body,status=200;
    await layer.route.stack[0].handle({query:{}},{status(s){status=s;return this},json(v){body=v;return this}});
    live.listLives=original;
    console.log(JSON.stringify({probe:'live-upstream-failure',httpStatus:status,response:body},null,2));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  // Keep the OS temporary fixture directory as evidence; contains no credentials.
  console.log('No production connection was made.');
}
async function online() {
 const {chromium}=req('playwright');
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const blocked=[],errors=[],failed=[],responses=[];
 // Allow only safe public listing/session reads and static resources; no live play,
 // relay, media download, login, POST/PUT/DELETE, model or admin operations.
 await context.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(r.method()!=='GET'|| /\/play(?:\?|$)|\/download|\/danmaku|\/streams\/|\/relays\/|\/replay-streams\//.test(u.pathname) || (u.pathname.startsWith('/api/admin/')&&u.pathname!=='/api/admin/auth/session')) {blocked.push({method:r.method(),path:u.pathname});return route.abort();}
   return route.continue();
 });
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push({url:page.url(),error:e.message}));
 page.on('requestfailed',r=>{if(r.url().startsWith('http://<SERVER_IP>:3000'))failed.push({url:r.url(),failure:r.failure()?.errorText});});
 page.on('response',r=>{if(r.url().startsWith('http://<SERVER_IP>:3000')&&(r.url().includes('/api/')||r.status()>=400))responses.push({url:r.url(),status:r.status()});});
 const pages=[];
 try {
  for(const p of ['/','/replays','/admin/login']) {
   await page.goto('http://<SERVER_IP>:3000'+p,{waitUntil:'networkidle',timeout:45000}).catch(e=>errors.push({url:p,error:e.message}));
   const snapshot=await page.evaluate(()=>({title:document.title,text:document.body.innerText.slice(0,6000),rootLength:document.querySelector('#root')?.innerHTML.length||0}));
   pages.push({path:p,...snapshot});
   await page.screenshot({path:path.join(__dirname,'online-'+(p==='/'?'home':p.replace(/\//g,'-').slice(1))+'.png'),fullPage:true});
  }
  const html=await (await context.request.get('http://<SERVER_IP>:3000/')).text();
  const local=fs.readFileSync(path.join(root,'client/dist/index.html'),'utf8');
  const assets=html.match(/(?:src|href)="(\/assets\/[^\"]+)"/g)||[];
  console.log(JSON.stringify({sampledAt:new Date().toISOString(),pages,errors,failed,responses,blocked,htmlEqualsLocal:html===local,entryAssets:assets},null,2));
 }finally {await browser.close();}
}
async function searchOnline() {
 const {chromium}=req('playwright');
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.request().method()==='GET'?r.continue():r.abort());
 try {
  await page.goto('http://<SERVER_IP>:3000/',{waitUntil:'networkidle',timeout:45000});
  const before=await page.locator('.public-live-card').count();
  await page.locator('input[type="search"], input[placeholder*="搜索"]').first().fill('audit-no-match-7f3c');
  await page.waitForFunction(()=>document.querySelector('#root')?.innerHTML.length===0,{},{timeout:5000}).catch(()=>{});
  const rootLength=await page.evaluate(()=>document.querySelector('#root')?.innerHTML.length||0);
  await page.screenshot({path:path.join(__dirname,'online-search-crash.png'),fullPage:true});
  const result={sampledAt:new Date().toISOString(),probe:'online-live-search',liveCardsBefore:before,query:'audit-no-match-7f3c',errors,rootLengthAfter:rootLength};
  fs.writeFileSync(path.join(__dirname,'online-search.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
 } finally {await browser.close();}
}
(mode==='search'?searchOnline():mode==='online'?online():offline()).catch(e=>{console.error(e);process.exitCode=1});
