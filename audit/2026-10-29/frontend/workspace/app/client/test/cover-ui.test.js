import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express'), { chromium } = require('playwright');

test('cover picker keeps captions below images, accepts uploads and redirects retired settings', { timeout: 60000 }, async () => {
  const app = express(), dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    browser = await chromium.launch({ headless: true, timeout: 15000, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
    const errors = [], saves = [], retiredRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      if (url.pathname === '/api/admin/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true }) });
      if (url.pathname.includes('/cover-settings') || url.pathname.includes('/cover-members')) {
        retiredRequests.push(url.pathname);
        return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Retired test endpoint' }) });
      }
      if (url.pathname.endsWith('/cover-candidates')) return send([{ file: 'a'.repeat(32)+'.jpg', source: 'original', label: '原直播封面', acceptable: true, recommended: true, reason: '清晰画面', url: '/test-original.jpg' }, { file: 'b'.repeat(32)+'.jpg', source: 'template', label: '成员模板', acceptable: true, reason: '使用成员照片', url: '/test-template.jpg' }]);
      if (url.pathname.endsWith('/cover')) { saves.push(route.request().postDataJSON()); return send({ coverSource: 'template', coverSyncPending: false }); }
      if (url.pathname.endsWith('/recordings/storage')) return send({ files: [], fileCount: 1, totalBytes: 1024 });
      if (url.pathname.endsWith('/recordings')) return send([{ id: 'rec-test', title: 'SNH48-测试成员-今晚聊天', memberName: '测试成员', status: 'done', fileSize: 1024 }]);
      if (url.pathname.endsWith('/queue')) return send([]);
      if (url.pathname.endsWith('/cover-batch')) return send({ status: 'idle' });
      return send({ authenticated: true, storage: { free: 1000, total: 2000, usedPercent: 50 } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/archive`);
    await page.getByRole('button', { name: '选择封面', exact: true }).click();
    await page.getByText(/所有图片完整居中，背景用同图虚化填满/).waitFor();
    assert.ok(await page.locator('.cover-candidate').first().evaluate(card => {
      const image = card.querySelector('.cover-candidate-image').getBoundingClientRect(), caption = card.querySelector('strong').getBoundingClientRect();
      return image.width >= card.getBoundingClientRect().width - 6 && caption.top >= image.bottom;
    }));
    await page.getByRole('button', { name: /成员模板.*使用成员照片/ }).click();
    await page.getByRole('button', { name: '使用此封面', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(saves[0], { candidateFile: 'b'.repeat(32)+'.jpg' });

    // The settings page was deliberately retired; upload remains supported in the picker.
    await page.getByRole('button', { name: '选择封面', exact: true }).click();
    await page.getByRole('button', { name: '使用此封面', exact: true }).waitFor();
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=';
    await page.locator('.cover-upload input').setInputFiles({ name: 'member.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
    await page.getByRole('button', { name: /自定义上传.*保存时自动适配封面尺寸/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: '使用此封面', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(saves[1], { image });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/cover-settings`);
    await page.waitForURL('**/admin/archive');
    await page.getByRole('button', { name: '选择封面', exact: true }).waitFor();
    assert.deepEqual(retiredRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
