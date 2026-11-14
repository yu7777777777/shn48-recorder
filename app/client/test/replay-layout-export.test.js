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
const replay={replayId:'123',title:'Layout replay',memberName:'Test member',liveType:1,duration:90};

async function fixture(t,{locale='zh-CN',stored,blocked=false}={}) {
  const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-layout-vite-'));
  let vite,server,browser;
  t.after(async()=>{
    try { await browser?.close(); }
    finally {
      await vite?.close();
      if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      fs.rmSync(cacheDir,{recursive:true,force:true});
    }
  });
  const entry="import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';import Page from '/src/pages/PublicReplay.jsx';import '/src/index.css';import '/src/App.css';createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(Routes,null,React.createElement(Route,{path:'/replays/:replayId',element:React.createElement(Page)}))));";
  vite=await viteServer({
    configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,
    define:{__APP_VERSION__:JSON.stringify('test')},
    server:{middlewareMode:true,hmr:false,ws:false},esbuild:{jsx:'automatic'},
    optimizeDeps:{noDiscovery:true,include:['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom','react-dom/client','react-router-dom','axios','hls.js','flv.js']},
    plugins:[{name:'replay-layout-fixture',resolveId(id){if(id==='/replay-layout-entry.js')return '\0replay-layout-entry';},load(id){if(id==='\0replay-layout-entry')return entry;}}],
  });
  server=httpServer((req,res)=>{
    if(req.url.startsWith('/replays/')){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/replay-layout-entry.js"></script>');}
    else vite.middlewares(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({locale,viewport:{width:1600,height:1100}});
  if(stored!==undefined)await context.addInitScript(value=>{if(!sessionStorage.getItem('layout-seeded')){localStorage.setItem('snh48.replay.layout',value);sessionStorage.setItem('layout-seeded','yes');}},stored);
  if(blocked)await context.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}}));
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const pageErrors=[];
  // Vite's CSS client imports a disabled dev socket; only ignore that transport shutdown.
  page.on('pageerror',error=>{if(error.message!=='WebSocket closed without opened.')pageErrors.push(error.message);});
  t.after(()=>assert.deepEqual(pageErrors,[]));
  const requests=[];
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='127.0.0.1')return route.abort();
    if(url.pathname.startsWith('/api/')){
      requests.push({method:route.request().method(),path:url.pathname});
      let data={};
      if(url.pathname.endsWith('/health'))data={status:'ok'};
      else if(url.pathname.endsWith('/play'))data={playUrl:'/fixtures/replay.m3u8',protocol:'hls',liveId:'123',danmakuAvailable:false};
      else if(url.pathname==='/api/public/replays/123')data=replay;
      else if(url.pathname==='/api/public/replays')data={items:[replay],hasMore:false};
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
    }
    if(url.pathname==='/fixtures/replay.m3u8')return route.fulfill({contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n/fixtures/one.ts\n#EXT-X-ENDLIST\n'});
    if(url.pathname==='/fixtures/one.ts')return route.fulfill({status:404,body:''});
    return route.continue();
  });
  const url='http://127.0.0.1:'+server.address().port+'/replays/123';
  await page.goto(url);
  await page.locator('.featured-replay h1').waitFor();
  return {page,url,requests};
}

test('replay defaults to portrait, switches columns and 16:9 stage, persists on reload and leaves download unchanged',async t=>{
  const {page,requests}=await fixture(t);
  const section=page.locator('.featured-replay');
  assert.match(await section.getAttribute('class'),/replay-layout-portrait/);
  assert.equal(await section.evaluate(el=>getComputedStyle(el).display),'block');
  assert.equal(await page.getByRole('button',{name:'竖屏',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.replay-detail-columns').evaluate(el=>getComputedStyle(el).display),'block');
  await page.getByRole('button',{name:'横屏',exact:true}).click();
  assert.match(await section.getAttribute('class'),/replay-layout-landscape/);
  assert.equal(await section.evaluate(el=>getComputedStyle(el).display),'block');
  assert.equal(await page.locator('.replay-stage').count(),1);
  assert.equal(await page.locator('.replay-stage').evaluate(el=>getComputedStyle(el).aspectRatio),'16 / 9');
  assert.equal(await page.getByRole('button',{name:'横屏',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.replay-detail-columns').evaluate(el=>getComputedStyle(el).display),'grid');
  assert.equal(await page.locator('.replay-detail-columns > .replay-detail-player').count(),1);
  assert.equal(await page.locator('.replay-detail-columns > .replay-detail-info').count(),1);
  await page.locator('.replay-detail-player .video-stage').waitFor();
  assert.equal(await page.locator('.replay-detail-player .video-stage').evaluate(el=>getComputedStyle(el).aspectRatio),'16 / 9');
  const boxes=await page.locator('.replay-detail-columns').evaluate(el=>[...el.children].map(child=>{const box=child.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top};}));
  assert.ok(boxes[0].right<=boxes[1].left);assert.ok(Math.abs(boxes[0].top-boxes[1].top)<2);
  assert.equal(await page.evaluate(()=>localStorage.getItem('snh48.replay.layout')),'landscape');
  await page.reload();await page.locator('.featured-replay h1').waitFor();assert.match(await section.getAttribute('class'),/replay-layout-landscape/);
  assert.equal(await page.getByRole('button',{name:'下载视频',exact:true}).count(),2);
  assert.equal(await page.getByLabel('多版本导出',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'导出所选版本',exact:true}).count(),0);
  assert.equal(await page.locator('.replay-version-export-note').count(),0);
  assert.equal(await page.locator('.replay-card-dl-btn').count(),1);
  assert.equal(requests.some(request=>request.method==='POST'),false);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.replay-detail-columns').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
});

test('English layout controls remain usable and unfinished export controls stay hidden',async t=>{
  const {page,requests}=await fixture(t,{locale:'en-US'});
  assert.equal(await page.getByRole('button',{name:'Portrait',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Landscape',exact:true}).click();
  assert.match(await page.locator('.featured-replay').getAttribute('class'),/replay-layout-landscape/);
  assert.equal(await page.getByLabel('Multi-version export',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Export selected version',exact:true}).count(),0);
  assert.equal(await page.locator('.replay-version-export-note').count(),0);
  assert.equal(requests.some(request=>request.method==='POST'),false);
});

test('invalid saved layout and blocked localStorage safely keep portrait defaults',async t=>{
  const invalid=await fixture(t,{stored:'invalid-layout'});
  assert.match(await invalid.page.locator('.featured-replay').getAttribute('class'),/replay-layout-portrait/);
  const blocked=await fixture(t,{blocked:true});
  assert.match(await blocked.page.locator('.featured-replay').getAttribute('class'),/replay-layout-portrait/);
  await blocked.page.getByRole('button',{name:'横屏',exact:true}).click();
  assert.match(await blocked.page.locator('.featured-replay').getAttribute('class'),/replay-layout-landscape/);
});
