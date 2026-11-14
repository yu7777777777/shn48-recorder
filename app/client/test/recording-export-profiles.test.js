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
const cpuDisclosure = '烧录字幕需重新完整编码视频';

// 真实转码导出面板（1.31 旧版只导出分析文本，本面板起由服务端真实编码）。
// Mount the real detail page with its real children; only HTTP data is mocked.
async function fixture(t) {
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
  return {page,server};
}

function installExportsMock(page, state) {
  return page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/api/admin/exports') {
      if (req.method() === 'GET') {
        state.gets += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: state.jobs }) });
      }
      if (req.method() === 'POST') {
        state.posts.push({ body: req.postDataJSON() });
        state.postCount += 1;
        const handler = state.onPost;
        if (handler) return handler(route, req.postDataJSON(), state.postCount);
        const job = { id: `exp_${state.postCount}`, recordingId: 'mock-record', profile: req.postDataJSON().profile, burnSubtitle: Boolean(req.postDataJSON().burnSubtitle), language: req.postDataJSON().language || null, status: 'done', progress: 100, fileName: `mock-record.${req.postDataJSON().profile}.mp4`, duration: 60 };
        state.jobs = [job, ...state.jobs];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: job }) });
      }
    }
    let data = {};
    if (url.pathname === '/api/admin/recordings/mock-record') data = { id: 'mock-record', status: 'done', title: '本地测试归档', filePath: 'mock.mp4', createdAt: '2026-10-22T00:00:00Z', duration: 60 };
    else if (url.pathname.endsWith('/clips') || url.pathname.endsWith('/queue')) data = [];
    else if (url.pathname.endsWith('/file')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: '' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
}

// Shared fixture wrapper that also installs the mock before navigation.
async function loadedFixture(t, state) {
  const built = await fixture(t);
  await installExportsMock(built.page, state);
  return built;
}

test('transcode export panel queues a real encode and lists jobs with a download link', async t => {
  const state = { jobs: [], posts: [], postCount: 0, gets: 0, onPost: null };
  const { page, server } = await loadedFixture(t, state);
  await page.goto('http://127.0.0.1:' + server.address().port);
  const panel = page.getByRole('region', { name: '转码导出', exact: true });
  await panel.waitFor();
  // The panel must state the burn-in CPU cost before any checkbox exists to click.
  assert.equal(await panel.getByText(cpuDisclosure).count(), 1);
  for (const [label, profile] of [['横屏 MP4', 'landscape'], ['竖屏 MP4', 'portrait'], ['仅音频 M4A', 'audio']]) {
    await panel.getByRole('button', { name: '导出（' + label + '）', exact: true }).click();
    await panel.getByText('已完成').first().waitFor();
  }
  assert.equal(state.posts.length, 3);
  assert.deepEqual(state.posts.map(post => post.body.profile), ['landscape', 'portrait', 'audio']);
  assert.ok(state.posts.every(post => post.body.recordingId === 'mock-record' && post.body.burnSubtitle === false));
  // Job rows expose the finished file through the authenticated download route.
  const link = panel.getByRole('link', { name: '下载' }).first();
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /^\/api\/admin\/exports\/exp_\d+\/download$/);
});

test('burn subtitle option rides on the queued job payload', async t => {
  const state = { jobs: [], posts: [], postCount: 0, gets: 0, onPost: null };
  const { page, server } = await loadedFixture(t, state);
  await page.goto('http://127.0.0.1:' + server.address().port);
  const panel = page.getByRole('region', { name: '转码导出', exact: true });
  await panel.waitFor();
  await panel.getByText('烧录字幕', { exact: true }).click();
  await panel.getByLabel('烧录字幕语言').selectOption('en');
  await panel.getByRole('button', { name: '导出（竖屏 MP4）', exact: true }).click();
  await panel.getByText('已完成').first().waitFor();
  assert.equal(state.posts[0].body.burnSubtitle, true);
  assert.equal(state.posts[0].body.language, 'en');
});

test('server 400 reason is visible verbatim and an explicit retry succeeds', async t => {
  const reason = '服务器拒绝该档位：测试原文 <b>不应变成HTML</b>';
  const state = {
    jobs: [], posts: [], postCount: 0,
    onPost: (route, body, count) => {
      if (count === 1) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: reason }) });
      const job = { id: 'exp_retry', recordingId: 'mock-record', profile: body.profile, burnSubtitle: false, language: null, status: 'done', progress: 100, fileName: `mock-record.${body.profile}.mp4`, duration: 60 };
      state.jobs = [job, ...state.jobs];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: job }) });
    },
  };
  const { page, server } = await loadedFixture(t, state);
  await page.goto('http://127.0.0.1:' + server.address().port);
  const panel = page.getByRole('region', { name: '转码导出', exact: true });
  await panel.waitFor();
  await panel.getByRole('button', { name: '导出（竖屏 MP4）', exact: true }).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByRole('alert').innerText(), reason);
  assert.equal(await panel.getByRole('alert').locator('b').count(), 0, 'reason must render as text, not HTML');
  // The queue keeps other buttons usable; an explicit second attempt succeeds.
  await panel.getByRole('button', { name: '导出（竖屏 MP4）', exact: true }).click();
  await panel.getByText('已完成').first().waitFor();
  assert.equal(await panel.getByRole('alert').count(), 0);
  assert.equal(state.posts.length, 2);
});
