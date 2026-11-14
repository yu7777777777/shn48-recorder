import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express'), { chromium } = require('playwright');

test('login methods isolate secrets, keep rejected credentials editable and preserve admin session expiry', { timeout: 60000 }, async () => {
  const app = express(), dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(dist + 'index.html'));
  const server = app.listen(0, '127.0.0.1');
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    browser = await chromium.launch({ headless: true, timeout: 15000, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    let reject = true, expireSession = false;
    await page.route('**/api/**', route => {
      const p = new URL(route.request().url()).pathname;
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const send = data => json(200, { success: true, data });
      // The administrator session is separate from the external Pocket48 account.
      if (p === '/api/admin/auth/session') return json(200, { authenticated: true });
      if (route.request().method() === 'POST') {
        calls.push({ path: p, body: route.request().postDataJSON() });
        // Match the real credential rejection contract, not an administrator 401.
        if (expireSession) return json(401, { success: false, error: '管理员会话已失效' });
        if (reject) return json(401, { success: false, errorCode: 'POCKET48_LOGIN_REJECTED', error: '测试凭据无效' });
        return send({ authenticated: true, health: 'ok' });
      }
      if (p.endsWith('/members')) return send({ list: [], groups: [] });
      return send({ authenticated: true, health: 'ok', members: [], maxConcurrent: 2 });
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.goto(origin + '/admin/auto-record?login=1');
    await page.getByRole('button', { name: '密码登录', exact: true }).click();
    const password = page.getByLabel('口袋48账号密码', { exact: true });
    await page.getByLabel('手机号 (中国大陆 11 位)').fill('13800000000');
    await password.fill('test-password');
    assert.equal(await password.getAttribute('type'), 'password');
    await page.getByRole('button', { name: '确认登录', exact: true }).click();
    await page.getByText('测试凭据无效', { exact: true }).waitFor();
    assert.deepEqual(calls[0], { path: '/api/admin/pocket48/login', body: { mobile: '13800000000', password: 'test-password' } });
    assert.equal(new URL(page.url()).pathname, '/admin/auto-record');
    assert.equal(await password.isEditable(), true);
    await password.fill('edited-password');

    await page.getByRole('button', { name: '凭据导入', exact: true }).click();
    assert.equal(await password.count(), 0);
    const token = page.getByLabel('访问凭据 Token', { exact: true });
    assert.equal(await token.getAttribute('type'), 'password');
    await token.fill('test-token');
    await page.getByRole('button', { name: '密码登录', exact: true }).click();
    assert.equal(await password.inputValue(), '');
    await page.getByRole('button', { name: '凭据导入', exact: true }).click();
    assert.equal(await token.inputValue(), '');
    await token.fill('test-token');
    // Token rejection must stay editable too, and must never send hidden password/mobile fields.
    await page.getByRole('button', { name: '确认登录', exact: true }).click();
    await page.getByText('测试凭据无效', { exact: true }).waitFor();
    assert.deepEqual(calls[1], { path: '/api/admin/pocket48/token', body: { token: 'test-token' } });
    assert.equal(await token.isEditable(), true);
    reject = false;
    await token.fill('replacement-token');
    await page.getByRole('button', { name: '确认登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录口袋48账号', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(calls[2], { path: '/api/admin/pocket48/token', body: { token: 'replacement-token' } });

    // An actual administrator 401 on the same endpoint must NOT get the exemption.
    await page.goto(origin + '/admin/auto-record?login=1');
    await page.getByRole('button', { name: '凭据导入', exact: true }).click();
    assert.equal(await token.inputValue(), '');
    await token.fill('test-token'); expireSession = true;
    await page.getByRole('button', { name: '确认登录', exact: true }).click();
    await page.waitForURL('**/admin/login?redirect=**');
    assert.equal(new URL(page.url()).searchParams.get('redirect'), '/admin/auto-record?login=1');
    assert.deepEqual(calls[3], { path: '/api/admin/pocket48/token', body: { token: 'test-token' } });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
