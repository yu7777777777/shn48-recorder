import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express'), { chromium } = require('playwright');
test('replay recovery returns progress, protects upload and remains usable on mobile', async () => {
  const app = express(), dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  let started = 0;
  const recording = { id: 'replay-ui', title: '测试成员直播', memberName: '测试成员', source: 'pocket48', liveId: '123', status: 'done', createdAt: '2026-09-28T00:00:00Z', filePath: '/recordings/local.mp4' };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, authenticated: true, data }) });
      if (url.pathname.endsWith('/recover-replay')) { started++; recording.replayRecovery = { status: 'downloading', progress: 50, totalSegments: 100, message: '正在下载回放分片 50/100' }; return send(recording); }
      if (url.pathname.endsWith('/recordings/replay-ui')) return send(recording);
      if (/\/clips$|\/queue$/.test(url.pathname)) return send([]);
      if (url.pathname.endsWith('/file')) return route.fulfill({ status: 404, body: '' });
      return send({ authenticated: true, segments: [], chapters: [], highlights: [] });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/archive/replay-ui`);
    await page.getByRole('button', { name: '下载回放并对比', exact: true }).click();
    await page.getByRole('button', { name: '回放处理中…', exact: true }).waitFor();
    assert.equal(started, 1); assert.ok(await page.getByRole('button', { name: '回放处理中…', exact: true }).isDisabled());
    assert.ok(await page.getByRole('button', { name: '送入 B站草稿', exact: true }).isDisabled());
    await page.getByText('正在下载回放分片 50/100 · 50%', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    recording.replayRecovery = { status: 'replaced', message: '已使用完整官方回放，原录像备份已保留', comparison: { localDuration: 120, officialDuration: 600, gainedSeconds: 480 } };
    recording.filePath = '/recordings/replay.mp4';
    await page.reload();
    await page.getByRole('button', { name: '已使用官方回放', exact: true }).waitFor();
    await page.getByRole('link', { name: '下载原录像备份', exact: true }).waitFor();
    await page.getByText('原录像 2 分 0 秒 · 官方回放 10 分 0 秒 · 多出 8 分 0 秒', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
