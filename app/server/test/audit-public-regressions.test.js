'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), '48-audit-public-'));
for (const name of ['DATA_DIR', 'POCKET48_DATA_DIR', 'RECORDINGS_DIR', 'COVERS_DIR']) process.env[name] = root;
process.env.CONFIG_PATH = path.join(root, 'config.yaml');
const live = require('../modules/pocket48/live');
const manager = require('../modules/recorder/manager');
const { danmakuManager } = require('../modules/pocket48/danmaku');
const router = require('../routes/public');
const { createApp } = require('../index');
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
function handler(route) { return router.stack.find(layer => layer.route?.path === route).route.stack[0].handle; }
function response() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, writes: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.writableEnded = true; this.emit('finish'); return this; },
    writeHead(code) { this.statusCode = code; this.headersSent = true; }, flushHeaders() {},
    write(value) { this.writes.push(value); }, end() { this.writableEnded = true; this.emit('finish'); },
  });
  return res;
}
function request() { const req = new EventEmitter(); req.params = { liveId: '123' }; req.query = {}; return req; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('F14: live upstream errors are 502, while a successful empty listing stays 200', async t => {
  t.mock.method(live, 'listLives', async () => { throw Error('private token must not leave server'); });
  const failed = response(); await handler('/live')(request(), failed);
  assert.equal(failed.statusCode, 502); assert.equal(failed.body.success, false);
  assert.equal(JSON.stringify(failed.body).includes('private token'), false);
  live.listLives = async () => ({ list: [], next: '0' });
  const empty = response(); await handler('/live')(request(), empty);
  assert.equal(empty.statusCode, 200); assert.equal(empty.body.success, true); assert.deepEqual(empty.body.data.liveList, []);
});

for (const closeKind of ['close', 'aborted']) test(`F13: SSE ${closeKind} during metadata lookup allocates no resources`, async t => {
  const metadata = deferred(); const req = request(), res = response(); let subscriptions = 0, timers = 0;
  t.mock.method(live, 'getLive', () => metadata.promise);
  t.mock.method(danmakuManager, 'subscribe', () => { subscriptions++; return () => {}; });
  t.mock.method(global, 'setInterval', () => { timers++; return { unref() {} }; });
  const pending = handler('/live/:liveId/danmaku')(req, res);
  if (closeKind === 'aborted') { req.aborted = true; req.emit('aborted'); }
  else { res.destroyed = true; res.emit('close'); }
  metadata.resolve({ roomId: '456' }); await pending;
  assert.equal(subscriptions, 0); assert.equal(timers, 0); assert.equal(res.headersSent, false);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('F13: a pending metadata rejection after disconnect does not write an error response', async t => {
  const metadata = deferred(), req = request(), res = response();
  t.mock.method(live, 'getLive', () => metadata.promise);
  const pending = handler('/live/:liveId/danmaku')(req, res);
  res.destroyed = true; res.emit('close'); metadata.reject(Error('offline'));
  await pending; assert.equal(res.body, undefined); assert.equal(res.headersSent, false);
});

test('F13: successful request receipt does not close SSE; response closure releases exactly once', async t => {
  const metadata = deferred(), req = request(), res = response(); let subscriptions = 0, releases = 0, timers = 0, cleared = 0;
  t.mock.method(live, 'getLive', () => metadata.promise);
  t.mock.method(danmakuManager, 'subscribe', (_id, send) => { subscriptions++; send('message', { text: 'safe' }); return () => { releases++; }; });
  t.mock.method(global, 'setInterval', () => { timers++; return { unref() {} }; });
  t.mock.method(global, 'clearInterval', () => { cleared++; });
  const pending = handler('/live/:liveId/danmaku')(req, res);
  req.emit('close'); // Node's request is fully received, not a response disconnect.
  metadata.resolve({ roomId: '456' }); await pending;
  assert.equal(subscriptions, 1); assert.equal(timers, 1); assert.equal(releases, 0); assert.equal(res.writes.length, 1);
  res.emit('close'); res.emit('finish'); req.emit('aborted');
  assert.equal(releases, 1); assert.equal(cleared, 1);
});

test('F13: synchronous disconnect from subscription callback also releases its returned lease', async t => {
  const req = request(), res = response(); let releases = 0, timers = 0;
  t.mock.method(live, 'getLive', async () => ({ roomId: '456' }));
  t.mock.method(danmakuManager, 'subscribe', () => { res.destroyed = true; res.emit('close'); return () => { releases++; }; });
  t.mock.method(global, 'setInterval', () => { timers++; return { unref() {} }; });
  await handler('/live/:liveId/danmaku')(req, res);
  assert.equal(releases, 1); assert.equal(timers, 0);
});
