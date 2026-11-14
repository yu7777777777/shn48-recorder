import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');
const { chromium } = require('playwright');
const base = '/api/admin/backup115';
const qrImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAN8AAAAASUVORK5CYII=';
const recording = (id, extra = {}) => ({ id, title: '归档' + id, status: 'done', fileSize: 2048, ...extra });
const job = (id, recordingId, status, extra = {}) => ({ id, recordingId, status, phase: status, progress: 50, totalBytes: 2048, uploadedBytes: 1024, files: [], ...extra });

// Tests the built application in real locally installed Chrome, with no 115 credentials or network calls.
test('115 backup built UI', async t => {
  const app = express();
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(dist + 'index.html'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const origin = process.env.UI_BASE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:' + server.address().port;
  async function fixture(options = {}) {
    const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 } });
    page.setDefaultTimeout(10000);
    const state = { jobs: [], recordings: [recording('1')], settings: { targetPath: '/48tools归档', autoBackup: false }, connection: { runtimeAvailable: true, authorized: false, accountLabel: '', message: '' }, qrStatus: 'waiting', qrExpires: null, calls: [], polls: 0, ...options };
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), p = new URL(request.url()).pathname, method = request.method();
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      const fail = (message, status = 500) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: message }) });
      state.calls.push({ path: p, method, body: method === 'POST' || method === 'PUT' ? request.postDataJSON() : undefined });
      if (p.startsWith(base)) {
        if (state.unavailable === '404') return fail('Not Found', 404);
        if (state.unavailable === 'empty') return send({});
        if (p === base + '/') { state.polls++; if (state.readError) return fail(state.readError); return send({ settings: state.settings, connection: state.connection, jobs: state.jobs }); }
        if (p === base + '/settings') { state.settings = request.postDataJSON(); return send(state.settings); }
        if (p === base + '/auth/qr') {
          if (state.qrError) return fail(state.qrError);
          return send({ sessionId: 'qr-test', qrDataUrl: qrImage, expiresAt: state.qrExpires || new Date(Date.now() + 60000).toISOString() });
        }
        if (p === base + '/auth/qr/qr-test') {
          if (state.statusError) return fail(state.statusError);
          if (state.qrStatus === 'signed_in') state.connection = { ...state.connection, authorized: true, accountLabel: '测试115' };
          return send({ status: state.qrStatus, connection: state.connection });
        }
        if (p.endsWith('/auth/check')) return send(state.connection);
        if (p.endsWith('/auth/logout')) { state.connection = { ...state.connection, authorized: false }; return send(state.connection); }
        if (p === base + '/jobs') {
          if (state.createHold) await state.createHold;
          const ids = request.postDataJSON().recordingIds;
          const jobs = ids.filter(id => String(id) !== state.rejectId).map(id => job('new-' + id, id, 'queued'));
          state.jobs.push(...jobs);
          return send({ jobs, errors: ids.filter(id => String(id) === state.rejectId).map(recordingId => ({ recordingId, error: '测试源文件暂不可备份' })) });
        }
        const match = p.match(new RegExp('/jobs/([^/]+)/(retry|cancel)$'));
        if (match) {
          const found = state.jobs.find(j => String(j.id) === decodeURIComponent(match[1]));
          found.status = match[2] === 'cancel' ? 'cancelled' : 'queued'; found.phase = found.status; found.error = null;
          return send(found);
        }
        return fail('Unexpected backup endpoint');
      }
      if (p.endsWith('/recordings/storage')) return send({ files: [{ id: 'disk-1', name: '共享缓存.flv', kind: 'source', size: 2048, locked: false }], fileCount: 1, totalBytes: 2048, extraBytes: 2048 });
      if (p.endsWith('/recordings/cover-batch')) return send({ status: 'idle' });
      if (p.endsWith('/recordings')) return send(state.recordings);
      if (p.endsWith('/queue')) return send([]);
      if (p.endsWith('/config')) return send({ recording: { outputDir: '/recordings' }, bilibili: { autoUpload: false } });
      if (method === 'DELETE') return send({});
      return send({ authenticated: true, available: true, storage: { free: 1024, total: 4096, usedPercent: 75 } });
    });
    return { page, state, errors, goto: path => page.goto(origin + '/admin/' + path, { waitUntil: 'domcontentloaded', timeout: 30000 }) };
  }
  try {
    await t.test('settings save independently, QR is requested only on click, and login/check/logout use separate endpoints', async () => {
      const f = await fixture(); const { page, state } = f;
      try {
        await f.goto('settings'); await page.getByRole('button', { name: '115扫码登录', exact: true }).waitFor();
        await page.getByLabel('115备份根目录').fill('/测试归档');
        await page.getByLabel('新归档自动备份到115（不批量补传历史归档）').check();
        assert.equal(state.calls.filter(c => c.path.includes('/auth/qr')).length, 0);
        await page.getByRole('button', { name: '保存115备份设置', exact: true }).click();
        await page.getByText('115备份设置已独立保存', { exact: true }).waitFor();
        assert.deepEqual(state.calls.find(c => c.path === base + '/settings').body, { targetPath: '/测试归档', autoBackup: true });
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await page.getByText('系统设置已保存', { exact: true }).waitFor();
        const configSave = state.calls.find(c => c.path === '/api/admin/config' && c.method === 'PUT');
        assert.ok(configSave); assert.doesNotMatch(JSON.stringify(configSave.body), /backup115|targetPath|autoBackup|Cookie|qrDataUrl/);
        await page.getByRole('button', { name: '115扫码登录', exact: true }).click();
        await page.getByAltText('115登录二维码').waitFor(); state.qrStatus = 'scanned';
        await page.getByText('已扫码，请在115 App确认登录', { exact: true }).waitFor(); state.qrStatus = 'signed_in';
        await page.getByText('已授权：测试115', { exact: true }).waitFor();
        assert.equal(await page.getByAltText('115登录二维码').count(), 0);
        assert.equal(await page.locator('input[type="password"]').count(), 0);
        await page.getByRole('button', { name: '检查115连接', exact: true }).click();
        await page.getByRole('button', { name: '注销115', exact: true }).click();
        await page.getByText('未授权115账号', { exact: true }).waitFor(); assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
    await t.test('QR cancellation stops polling, expired QR and HTTP failures remain explicit', async () => {
      const f = await fixture(); const { page, state } = f;
      try {
        await f.goto('settings'); await page.getByRole('button', { name: '115扫码登录', exact: true }).click();
        await page.getByAltText('115登录二维码').waitFor();
        await page.getByRole('button', { name: '取消扫码登录', exact: true }).click();
        const before = state.calls.filter(c => c.path === base + '/auth/qr/qr-test').length;
        await page.waitForTimeout(2300);
        assert.equal(state.calls.filter(c => c.path === base + '/auth/qr/qr-test').length, before);
        state.qrExpires = new Date(Date.now() - 1000).toISOString();
        await page.getByRole('button', { name: '115扫码登录', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '扫码登录超时' }).waitFor();
        await page.getByRole('button', { name: '取消扫码登录', exact: true }).click();
        state.qrExpires = null; state.statusError = '扫码状态接口异常';
        await page.getByRole('button', { name: '115扫码登录', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '扫码状态接口异常' }).waitFor();
        await page.getByRole('button', { name: '取消扫码登录', exact: true }).click();
        state.statusError = null; state.qrError = '115登录运行时不可用';
        await page.getByRole('button', { name: '115扫码登录', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '115登录运行时不可用' }).waitFor(); assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
    await t.test('independent selection accepts Bilibili-uploaded archives and shows partial submission errors', async () => {
      const f = await fixture({ recordings: [recording('1', { uploadStatus: 'done', backup115: { status: 'succeeded' } }), recording('2')], rejectId: '2' });
      const { page, state } = f;
      try {
        await f.goto('archive'); await page.getByLabel('选择115备份 归档1', { exact: true }).check();
        assert.equal(await page.getByLabel('选择录像 归档1', { exact: true }).isChecked(), false);
        assert.equal(await page.getByLabel('选择录像 归档1', { exact: true }).isDisabled(), true);
        const first = page.locator('.archive-record-card').filter({ hasText: '归档1' });
        await first.getByText('未备份', { exact: true }).waitFor();
        await page.getByLabel('选择115备份 归档2', { exact: true }).check();
        await page.getByRole('button', { name: '备份所选到115（2）', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '2：测试源文件暂不可备份' }).waitFor();
        assert.deepEqual(state.calls.find(c => c.path === base + '/jobs' && c.method === 'POST').body, { recordingIds: ['1', '2'] });
        await first.getByRole('button', { name: '取消115备份', exact: true }).waitFor();
        assert.equal(await first.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
        await first.getByRole('button', { name: '取消115备份', exact: true }).click();
        await first.getByText('已取消', { exact: true }).waitFor();
        assert.equal(await first.getByRole('button', { name: '删除', exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '批量重新生成', exact: true }).isDisabled(), true);
        assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
    await t.test('all active states lock deletion, retries and file failures render, and only evidence-backed success is verified', async () => {
      const statuses = ['queued', 'hashing', 'uploading', 'verifying', 'retry_wait', 'waiting_credentials', 'succeeded', 'partial', 'failed', 'cancelled', 'stale_source'];
      const f = await fixture({ recordings: statuses.map((_, i) => recording(String(i))), jobs: statuses.map((status, i) => job('j' + i, String(i), status, status === 'succeeded' ? { verifiedAt: '2026-10-20T08:00:00Z', remotePath: '/归档/校验' } : status === 'partial' ? { error: '附件未完整备份', files: [{ role: 'subtitle', name: '字幕.srt', status: 'failed', size: 100, remoteFileId: '12345678901234567890', error: '字幕上传失败' }] } : {})) });
      const { page, state } = f;
      try {
        await f.goto('archive'); await page.getByText('附件未完整备份', { exact: true }).waitFor();
        for (let i = 0; i < 6; i++) assert.equal(await page.locator('.archive-record-card').filter({ has: page.getByRole('link', { name: '归档' + i, exact: true }) }).getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
        await page.getByText('字幕.srt：字幕上传失败', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '使用中', exact: true }).isDisabled(), true);
        await page.getByText('已校验', { exact: true }).waitFor();
        const partial = page.locator('.archive-record-card').filter({ has: page.getByRole('link', { name: '归档7', exact: true }) });
        await partial.getByRole('button', { name: '重试115备份', exact: true }).click();
        await partial.getByText('等待备份', { exact: true }).waitFor();
        assert.ok(state.calls.find(c => c.path === base + '/jobs/j7/retry'));
        state.jobs[6].verifiedAt = null;
        await page.getByRole('button', { name: '刷新115状态', exact: true }).click();
        await page.getByText('上传完成 · 尚无校验证据', { exact: true }).waitFor(); assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
    await t.test('periodic GET updates job facts and mobile backup controls fit the viewport', async () => {
      const f = await fixture({ mobile: true, jobs: [job('mobile', '1', 'uploading')] }); const { page, state } = f;
      try {
        await f.goto('archive'); await page.getByRole('button', { name: '取消115备份', exact: true }).waitFor();
        const count = state.polls; state.jobs[0] = { ...state.jobs[0], status: 'succeeded', verifiedAt: '2026-10-20T08:00:00Z' };
        await page.getByText('已校验', { exact: true }).waitFor({ timeout: 9000 }); assert.ok(state.polls > count);
        const bounds = await page.locator('.backup115-toolbar,.backup115-record').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
        assert.ok(bounds.every(r => r.left >= 0 && r.right <= 390), JSON.stringify(bounds)); assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
    await t.test('pending submissions and a newly active job also protect an already-open delete dialog', async () => {
      let release;
      const createHold = new Promise(resolve => { release = resolve; });
      const f = await fixture({ createHold }); const { page, state } = f;
      try {
        await f.goto('archive');
        const remove = page.getByRole('button', { name: '删除', exact: true });
        await page.getByRole('button', { name: '备份到115', exact: true }).waitFor();
        await Promise.all([page.waitForRequest(r => r.url().endsWith(base + '/jobs')), page.getByRole('button', { name: '备份到115', exact: true }).click()]);
        assert.equal(await remove.isDisabled(), true);
        release(); await page.getByRole('button', { name: '取消115备份', exact: true }).waitFor();
        await page.getByRole('button', { name: '取消115备份', exact: true }).click();
        await page.getByText('已取消', { exact: true }).waitFor();
        await remove.click(); await page.getByRole('dialog').waitFor();
        state.jobs[0].status = 'verifying';
        // A task can become active in another admin session while this modal is open.
        await page.getByRole('button', { name: '取消115备份', exact: true }).waitFor({ timeout: 9000 });
        await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
        await page.getByText('115备份任务正在使用文件或状态尚未确认，请取消备份并刷新后再删除', { exact: true }).waitFor();
        assert.equal(state.calls.filter(c => c.method === 'DELETE').length, 0);
        await page.getByRole('button', { name: '取消', exact: true }).click();
        state.readError = '115状态暂时不可读';
        await page.getByRole('button', { name: '刷新115状态', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '115状态暂时不可读' }).waitFor();
        assert.equal(await remove.isDisabled(), true);
        state.readError = null; state.jobs[0].status = 'cancelled';
        await page.getByRole('button', { name: '刷新115状态', exact: true }).click();
        await page.getByText('已取消', { exact: true }).waitFor();
        assert.equal(await remove.isEnabled(), true); assert.deepEqual(f.errors, []);
      } finally { release(); await page.close(); }
    });
    for (const unavailable of ['404', 'empty']) await t.test('legacy ' + unavailable + ' response keeps ordinary archive/settings usable', async () => {
      const f = await fixture({ unavailable }); const { page } = f;
      try {
        await f.goto('archive'); await page.getByText('115备份服务尚未启用', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isEnabled(), true);
        await f.goto('settings'); await page.getByText('115备份服务尚未启用', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '115扫码登录', exact: true }).isDisabled(), true); assert.deepEqual(f.errors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
