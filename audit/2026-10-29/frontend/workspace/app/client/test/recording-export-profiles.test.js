import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as httpServer } from 'node:http';
import { createServer as viteServer } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { chromium } = require('playwright');
const disclosure = '当前导出的是分析文本与档位参数，不会生成转码后的横屏/竖屏/音频文件';

// Mount the real detail page with its real children and API module; only HTTP data is mocked.
async function fixture(t, exportResponse) {
  const entry = "import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';import Detail from '/src/pages/RecordingDetail.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/admin/archive/mock-record']},React.createElement(Routes,null,React.createElement(Route,{path:'/admin/archive/:id',element:React.createElement(Detail)}))));";
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-export-vite-'));
  const vite = await viteServer({configFile:false,esbuild:{jsx:'automatic'},root:fileURLToPath(new URL('../',import.meta.url)),cacheDir,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true,include:['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom','react-dom/client','react-router-dom','axios']},plugins:[{name:'export-profile-fixture',resolveId(id){if(id==='/export-profile-entry.js')return '\0export-profile-entry';},load(id){if(id==='\0export-profile-entry')return entry;}}]});
  const server = httpServer((req,res) => {if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script type="module" src="/export-profile-entry.js"></script>');}else vite.middlewares(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await vite.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(cacheDir,{recursive:true,force:true});}});
  browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => console.error('Export fixture browser error:', error.message));
  const requests = [];
  await page.route('**/api/**',async route=>{
    const req = route.request(), url = new URL(req.url());
    if(url.pathname==='/api/admin/analysis/mock-record/summary') {
      requests.push({url:url.href,method:req.method()});
      return exportResponse(route, url, requests.length);
    }
    let data = {};
    if(url.pathname==='/api/admin/recordings/mock-record') data={id:'mock-record',status:'done',title:'本地测试归档',filePath:'mock.mp4',createdAt:'2026-10-22T00:00:00Z',duration:60};
    else if(url.pathname.endsWith('/clips')||url.pathname.endsWith('/queue')) data=[];
    else if(url.pathname.endsWith('/file')) return route.fulfill({status:200,contentType:'video/mp4',body:''});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  const panel = page.getByRole('region',{name:'导出',exact:true});
  await panel.waitFor();
  return {page,panel,requests};
}

test('real detail export buttons send each profile in URL and unchanged encoding stays explicit', async t=>{
  const {page,panel,requests}=await fixture(t,route=>route.fulfill({status:200,contentType:'text/markdown',headers:{'X-Export-Encoding':'unchanged','X-Export-Profile':'metadata-only'},body:'# 测试分析文本'}));
  assert.equal(requests.length,0);
  assert.equal(await panel.getByRole('button').count(),3);
  for(const [label,profile] of [['横屏','landscape'],['竖屏','portrait'],['仅音频','audio']]) {
    const response=page.waitForResponse(r=>new URL(r.url()).searchParams.get('profile')===profile);
    await panel.getByRole('button',{name:'导出（'+label+'）',exact:true}).click();
    assert.equal((await response).headers()['x-export-encoding'],'unchanged');
    await panel.getByRole('link',{name:'下载导出文件'}).waitFor();
    assert.equal(await panel.getByText(disclosure,{exact:true}).count(),1);
    assert.match(await panel.getByRole('status').innerText(),/未进行媒体转码/);
    assert.equal(new URL(requests.at(-1).url).searchParams.get('profile'),profile);
    assert.equal(new URL(requests.at(-1).url).searchParams.get('format'),'markdown');
    assert.equal(requests.at(-1).method,'GET');
    const href=await panel.getByRole('link',{name:'下载导出文件'}).getAttribute('href');
    assert.match(href,/^blob:/);
    assert.equal(await page.evaluate(async url=>(await fetch(url)).text(),href),'# 测试分析文本');
  }
  assert.equal(requests.length,3);
});

test('server 400 reason is visible verbatim and busy recovers for explicit retry and returned URL',async t=>{
  let release;
  const held=new Promise(resolve=>release=resolve);
  const reason='服务器拒绝该档位：测试原文 <b>不应变成HTML</b>';
  const {page,panel,requests}=await fixture(t,async(route,url,count)=>{
    if(count===1){await held;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({success:false,error:reason})});}
    return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{url:'/api/admin/exports/local-test.md'}})});
  });
  const requested=page.waitForRequest(req=>req.url().includes('profile=portrait'));
  await panel.getByRole('button',{name:'导出（竖屏）',exact:true}).click();
  await requested;
  await panel.getByText('正在导出，请稍候…',{exact:true}).waitFor();
  assert.equal(await panel.locator('button:disabled').count(),3);
  release();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByRole('alert').innerText(),reason);
  assert.equal(await panel.getByRole('alert').locator('b').count(),0);
  assert.equal(await panel.locator('button:disabled').count(),0);
  assert.equal(await panel.getByRole('link').count(),0);
  assert.equal(requests.length,1);
  await panel.getByRole('button',{name:'导出（竖屏）',exact:true}).click();
  const link=panel.getByRole('link',{name:'下载导出文件'});
  await link.waitFor();
  assert.equal((await link.getAttribute('href')).endsWith('/api/admin/exports/local-test.md'),true);
  assert.equal(await panel.getByRole('alert').count(),0);
  assert.equal(requests.length,2);
});
