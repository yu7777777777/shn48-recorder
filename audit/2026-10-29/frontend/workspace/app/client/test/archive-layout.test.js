import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');
const { chromium } = require('playwright');

test('archive cards keep cover, status and actions visible on desktop and mobile', async () => {
  const app = express();
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, authenticated: true, data }) });
      if (url.pathname.endsWith('/recordings/storage')) return send({ files: [], fileCount: 1, totalBytes: 1024 });
      if (url.pathname.endsWith('/recordings')) return send([{ id: 'rec-layout', title: 'SNH48-测试成员-今晚聊天', status: 'done', source: 'pocket48', coverSource: 'smart', container: 'mp4', fileSize: 1024, createdAt: '2026-09-29T04:00:00Z' }]);
      if (url.pathname.endsWith('/queue')) return send([]);
      if (url.pathname.endsWith('/cover-batch')) return send({ status: 'idle' });
      return send({ authenticated: true, storage: { free: 1000, total: 2000, usedPercent: 50 } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/archive`);
    const card = page.locator('.archive-record-card');
    await card.waitFor();
    assert.equal(await card.count(), 1);
    assert.equal(await card.getByRole('link', { name: 'SNH48-测试成员-今晚聊天' }).count(), 1);
    assert.equal(await card.getByText('已归档').count(), 1);
    assert.equal(await card.getByRole('button', { name: '选择封面' }).count(), 1);
    assert.equal(await card.getByRole('button', { name: '送入B站草稿' }).count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await card.locator('.archive-record-cover').isVisible());
    assert.ok(await card.getByRole('button', { name: '送入B站草稿' }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
