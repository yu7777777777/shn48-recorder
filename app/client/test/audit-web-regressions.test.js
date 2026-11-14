import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(join(root, 'src', name), 'utf8');
const liveSource = read('pages/PublicLive.jsx');
const replaySource = read('pages/PublicReplay.jsx');
const overlaySource = read('components/ReplayDanmakuOverlay.jsx');
function cut(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Source marker changed: ${start}`);
  return source.slice(a, b);
}
const texts = vm.runInNewContext(cut(replaySource, 'const TEXT =', 'export function languageOf(') + ';TEXT');
const payload = response => response.data;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('F01 numeric live categories support empty, matching and nonmatching searches', () => {
  const normalize = vm.runInNewContext(cut(liveSource, 'function normalizeLive(', 'function formatStartedAt(') + ';normalizeLive');
  const filter = cut(liveSource, '    return lives.filter(', '  }, [lives, searchQuery]);');
  const lives = [1, 2].map(liveType => normalize({ liveId: String(liveType), title: '测试标题', member: { name: '成员' }, liveType }));
  assert.ok(lives.every(row => typeof row.category === 'string'));
  for (const [q, count] of [['', 2], ['成员', 2], ['测试', 2], ['1', 1], ['no-match', 0]]) {
    assert.equal(vm.runInNewContext('(function(){' + filter + '})()', { lives, q }).length, count);
  }
});

test('F10 all replay types, fallback fields and map normalization remain usable', () => {
  const functions = cut(replaySource, 'function replayCategory(', 'function formatReplayTime(');
  const { normalizeReplay, replayPage } = vm.runInNewContext(functions + ';({normalizeReplay,replayPage})', { TEXT: texts, payload });
  for (const [liveType, expected] of [[1, '视频直播'], [2, '电台直播'], [5, '游戏直播'], [6, 'AI 直播'], [null, '视频直播']]) {
    assert.equal(normalizeReplay({ liveId: '1', liveType }).category, expected);
  }
  assert.equal(normalizeReplay({ liveId: '1', liveType: 5 }, texts.en).category, 'Game live');
  const page = replayPage({ data: { list: [{ liveId: '1', liveType: 5 }, { liveId: '2', liveType: 6 }, { liveId: '3' }] } });
  assert.equal(page.items.length, 3);
  assert.equal(page.items[1].title, texts.zh.detail.memberLive);
});

test('F11 first-load toggle aborts old fetch, retries, and ignores old success/error', async () => {
  const body = cut(overlaySource, '    // A toggle can cancel', '  }, [enabled, normalizedReplayId, available]');
  let status = 'idle', records = [], requestCount = 0;
  const requests = [];
  const env = () => ({ enabled: true, normalizedReplayId: '1', available: true, status, AbortController,
    setStatus: value => { status = value; }, setRecords: value => { records = value; }, payload,
    normalizeReplayDanmakuList: list => list,
    publicApi: { get: (_url, options) => { requestCount++; const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise; } },
  });
  const run = (extra = {}) => vm.runInNewContext('(function(){' + body + '})()', { ...env(), ...extra });
  const cleanup = run();
  assert.equal(status, 'loading');
  cleanup(); assert.equal(requests[0].signal.aborted, true);
  run({ enabled: false });
  const cleanupReplacement = run();
  assert.equal(requestCount, 2);
  requests[0].resolve({ data: { list: [{ text: 'stale' }] } }); await flush();
  assert.equal(records.length, 0);
  requests[1].resolve({ data: { list: [{ text: 'current' }] } }); await flush();
  assert.equal(status, 'ready'); assert.equal(records[0].text, 'current');
  cleanupReplacement(); run(); assert.equal(requestCount, 2, 'ready data is reused when toggled');
  // A failed in-flight request must not change a replacement request to error.
  status = 'idle'; const cleanupError = run(); cleanupError(); run();
  requests[2].reject(new Error('stale failure')); await flush(); assert.equal(status, 'loading');
  requests[3].resolve({ data: { list: [] } }); await flush(); assert.equal(status, 'empty');
});

// Minimal React-hook lifecycle driver, executing the actual shared download hook.
// Deferred mocks deliberately ignore AbortSignal to exercise ownership checks too.
function downloadHarness() {
  const slots = [], effects = []; let index = 0, effectIndex = 0;
  let routeReplayId, state, posts = [], gets = [], href = '', timers = new Map(), timerId = 0;
  const env = {
    AbortController, payload, errorMessage: (error, fallback) => error.message || fallback,
    useParams: () => ({ replayId: routeReplayId }),
    useState: initial => { const i = index++; if (!(i in slots)) slots[i] = initial; state = slots[i]; return [slots[i], value => { slots[i] = value; state = value; }]; },
    useRef: value => { const i = index++; return slots[i] ||= { current: value }; },
    useCallback: fn => fn,
    useEffect: (fn, deps) => {
      const i = effectIndex++, previous = effects[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() };
      }
    },
    window: { clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
      location: { set href(value) { href = value; } } },
    publicApi: {
      post: (url, _body, options) => { const d = deferred(); posts.push({ ...d, url, signal: options.signal }); return d.promise; },
      get: (url, options) => { const d = deferred(); gets.push({ ...d, url, signal: options.signal }); return d.promise; },
    },
  };
  const hook = vm.runInNewContext(cut(replaySource, 'function useReplayDownload(', 'function ReplayCard(') + ';useReplayDownload', env);
  return {
    render(id, route = id) { index = 0; effectIndex = 0; routeReplayId = route; return hook(id, texts.zh); },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
    tick() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) void callback(); },
    get state() { return state; }, get posts() { return posts; }, get gets() { return gets; },
    get timers() { return timers.size; }, get href() { return href; },
  };
}

for (const phase of ['post', 'get']) {
  for (const leave of ['route', 'unmount', 'card-route']) {
    test(`F12 ${leave}: stale ${phase.toUpperCase()} cannot restore state/timer or navigate`, async () => {
      const h = downloadHarness(); const [, start] = h.render('A', 'A');
      const pending = start();
      if (phase === 'get') { h.posts[0].resolve({}); await flush(); assert.equal(h.gets.length, 1); }
      if (leave === 'unmount') h.unmount();
      else h.render(leave === 'card-route' ? 'A' : 'B', 'B');
      assert.equal(h.posts[0].signal.aborted, true);
      if (phase === 'post') h.posts[0].resolve({});
      else h.gets[0].resolve({ data: { status: 'ready' } });
      await pending; await flush();
      assert.equal(h.timers, 0); assert.equal(h.href, '');
      if (leave !== 'unmount') assert.equal(h.state.status, 'idle');
      assert.equal(h.gets.length, phase === 'post' ? 0 : 1);
    });
  }
}

test('F12 normal preparation, ready, failed retry, duplicate suppression and timer cleanup', async () => {
  const h = downloadHarness(); const [, start] = h.render('A');
  const first = start(); void start(); assert.equal(h.posts.length, 1);
  h.posts[0].resolve({}); await flush();
  h.gets[0].resolve({ data: { status: 'preparing', progress: 15 } }); await first;
  assert.equal(h.timers, 1); assert.equal(h.state.progress, 15);
  h.tick(); h.gets[1].resolve({ data: { status: 'ready' } }); await flush();
  assert.equal(h.href, '/api/public/replays/A/download');
  const again = start(); h.posts[1].reject(new Error('failed request')); await again;
  assert.equal(h.state.status, 'failed');
  const retry = start(); h.posts[2].resolve({}); await flush();
  h.gets[2].resolve({ data: { status: 'preparing' } }); await retry;
  assert.equal(h.timers, 1); h.unmount(); assert.equal(h.timers, 0);
  h.tick(); assert.equal(h.gets.length, 3);
});

test('F01/F10/F11/F14 current-source Chrome regression with mocked APIs only', { timeout: 90000 }, async () => {
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const express = require('express'), { chromium } = require('playwright');
  const cacheDir = mkdtempSync(join(tmpdir(), 'shn48-audit-web-'));
  const app = express();
  const vite = await createServer({ root, cacheDir, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('*', async (req, res, next) => {
    try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); }
    catch (error) { next(error); }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ locale: 'zh-CN' }); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => { if (!/WebSocket closed without opened/.test(error.message)) errors.push(error.message); });
    let liveFailure = false, danmakuReads = 0; const heldDanmaku = [];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const send = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      if (url.pathname.endsWith('/health')) return send({ status: 'ok' });
      if (url.pathname === '/api/public/live') {
        if (liveFailure) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Live list is unavailable' }) });
        return send({ liveList: [1, 2].map(liveType => ({ liveId: String(liveType), title: '标题' + liveType, member: { name: '成员' + liveType }, liveType })) });
      }
      if (url.pathname === '/api/public/replays') return send({ list: [1, 2, 5, 6, null].map((liveType, index) => ({ liveId: String(index + 1), title: '回放' + index, liveType, member: { name: '测试成员' } })), next: '0' });
      if (url.pathname.endsWith('/danmaku')) {
        danmakuReads++;
        if (danmakuReads === 1) { heldDanmaku.push(route); return; }
        return send({ list: [{ id: 'current', nickname: '测试观众', text: '新请求弹幕', atMs: 0 }] });
      }
      if (url.pathname.endsWith('/play')) return send({ liveId: '1', protocol: 'hls', playUrl: '/mock.m3u8', danmakuAvailable: true });
      if (url.pathname.endsWith('/summary')) return route.fulfill({ status: 404, body: '{}' });
      if (/\/replays\/\d+$/.test(url.pathname)) return send({ liveId: url.pathname.split('/').at(-1), liveType: 1, title: '详情回放', member: { name: '测试成员' } });
      throw new Error('Unexpected API request: ' + url.pathname);
    });
    await page.route('**/mock.m3u8', route => route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-ENDLIST\n' }));
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.locator('.public-live-card').nth(1).waitFor();
    const search = page.getByPlaceholder('搜索成员或标题…');
    await search.fill('audit-no-match'); await page.getByText('没有匹配的直播', { exact: true }).waitFor();
    await search.fill('成员1'); await page.waitForFunction(() => document.querySelectorAll('.public-live-card').length === 1);
    await search.fill(''); await page.locator('.public-live-card').nth(1).waitFor();
    liveFailure = true;
    await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.getByText('直播列表暂时不可用', { exact: true }).waitFor();
    assert.equal(await page.getByText('当前没有正在进行的直播', { exact: true }).count(), 0);
    await page.goto(base + '/replays', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.locator('.replay-card').nth(4).waitFor();
    await page.locator('.replay-card-main').first().click();
    const toggle = page.locator('.replay-danmaku-toggle');
    await toggle.click(); await page.waitForFunction(() => document.querySelector('.replay-danmaku-toggle')?.textContent.includes('加载中'));
    await toggle.click(); await toggle.click();
    await page.getByText('共 1 条弹幕', { exact: true }).waitFor();
    assert.equal(danmakuReads, 2);
    for (const route of heldDanmaku) await route.abort().catch(() => {});
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await new Promise(resolve => server.close(resolve));
    // This is the exact mkdtemp path owned by this test, never app/dist or shared cache.
    assert.ok(cacheDir.startsWith(join(tmpdir(), 'shn48-audit-web-')));
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
