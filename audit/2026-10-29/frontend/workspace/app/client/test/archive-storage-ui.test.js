import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');
const { chromium } = require('playwright');
test('archive renders all six files and cleanup requires confirmation then refreshes totals', async () => {
  const app = express();
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    let files = Array.from({length:6}, (_,i) => ({id:String(i),name:`录像-${i}.${i ? 'flv' : 'mp4'}`,kind:i===0?'main':i<4?'source':'residual',size:1024,locked:false}));
    let deletes = 0;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const send = data => route.fulfill({ contentType:'application/json',body:JSON.stringify({success:true,data,authenticated:true}) });
      if (route.request().method()==='DELETE') { deletes++; files=files.filter(f=>!url.pathname.endsWith('/'+f.id)); return send({}); }
      if(url.pathname.endsWith('/recordings/storage')) return send({files,fileCount:files.length,totalBytes:files.length*1024,extraBytes:(files.length-1)*1024});
      if(url.pathname.endsWith('/recordings')) return send([{id:'main',title:'测试归档',status:'done',fileSize:1024}]);
      if(url.pathname.endsWith('/queue')) return send([]);
      return send({authenticated:true,storage:{free:1000,total:2000,usedPercent:50}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/archive`);
    await page.getByRole('heading',{name:'磁盘文件清单 · 6 个文件'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'清理文件',exact:true}).count(),5);
    await page.getByRole('button',{name:'清理文件',exact:true}).first().click();
    await page.getByRole('button',{name:'取消',exact:true}).click(); assert.equal(deletes,0);
    await page.getByRole('button',{name:'清理文件',exact:true}).first().click();
    await page.getByRole('button',{name:'确认永久删除',exact:true}).click();
    await page.getByRole('heading',{name:'磁盘文件清单 · 5 个文件'}).waitFor(); assert.equal(deletes,1);
    await page.screenshot({path:fileURLToPath(new URL('../../docs/archive-storage-preview.png',import.meta.url)),fullPage:true});
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});
