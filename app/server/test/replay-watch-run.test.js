'use strict';
// Contract tests for the manual replay-watch run and the tick() result object:
// force runs must stamp the real clock (never the caller-provided time), the
// result must distinguish "nothing new" from "Pocket48 unreachable", and a
// replay that is not public yet is normal, never an error code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.POCKET48_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-run-'));
const watch = require('../modules/pocket48/replay-watch');
const intake = require('../modules/analysis/replay-intake');
const ID = '482000000000000002';
const UNREACHABLE = '口袋48回放列表暂时无法访问';

const originalPreview = intake.preview;
const originalConfirm = intake.confirm;
test.after(() => { intake.preview = originalPreview; intake.confirm = originalConfirm; });

test('force tick bypasses the day gate and stamps the real clock', async () => {
  watch.configure({ enabled: true, memberId: ID, memberName: '强制巡检' });
  let calls = 0;
  watch._internals.setLister(async () => { calls += 1; return { list: [] }; });
  const before = Date.now() - 1000;
  // Even a caller that passes "tomorrow" as now must not pollute the timestamp.
  const first = await watch.tick(Date.now() + watch._internals.DAY_MS, { force: true });
  const after = Date.now() + 1000;
  assert.deepEqual(first, { queued: 0 });
  assert.equal(calls, 1);
  const stamped = Date.parse(watch.status().lastAttemptAt);
  assert.ok(stamped >= before && stamped <= after, `lastAttemptAt must be the real clock, got ${watch.status().lastAttemptAt}`);
  assert.ok(Math.abs(Date.parse(watch.status().nextAt) - (stamped + watch._internals.DAY_MS)) < 1000, 'the next sweep is tomorrow, not the day after');
  // Force runs again immediately even though an attempt was just recorded.
  const second = await watch.tick(Date.now(), { force: true });
  assert.deepEqual(second, { queued: 0 });
  assert.equal(calls, 2);
  // The 24h gate still applies to the automatic path.
  const automatic = await watch.tick(Date.now());
  assert.deepEqual(automatic, { queued: 0 });
  assert.equal(calls, 2, 'a non-force tick inside the same day does not call upstream');
});

test('replay_not_ready is normal: no error code, but the poll still counts as successful', async () => {
  watch.configure({ enabled: true, memberId: ID });
  const startedAt = new Date().toISOString();
  watch._internals.setLister(async () => ({ list: [
    { liveId: '9001', member: { id: ID }, startedAt },
    { liveId: '9002', member: { id: ID }, startedAt },
  ] }));
  intake.preview = async () => { throw Object.assign(new Error('该链接不是可处理的已结束公开回放'), { code: 'replay_not_ready', statusCode: 409 }); };
  const result = await watch.tick(Date.now(), { force: true });
  assert.deepEqual(result, { queued: 0 });
  assert.equal(watch.status().lastErrorCode, '', 'a not-yet-public replay must not enter lastErrorCode');
  assert.ok(watch.status().lastSuccessAt, 'a poll that only saw unpublished replays is still successful');
  assert.equal(watch.status().lastQueued, 0);
});

test('ready replays are queued through intake and counted in the result object', async () => {
  watch.configure({ enabled: true, memberId: ID });
  const startedAt = new Date().toISOString();
  watch._internals.setLister(async () => ({ list: [{ liveId: '9003', member: { id: ID }, startedAt }] }));
  let previewed = '';
  intake.preview = async source => { previewed = source; return { previewId: 'pv1' }; };
  intake.confirm = id => { assert.equal(id, 'pv1'); return { kind: 'import', job: { id: 'job1' } }; };
  const result = await watch.tick(Date.now(), { force: true });
  assert.deepEqual(result, { queued: 1 });
  assert.match(previewed, /\?id=9003$/);
  assert.equal(watch.status().lastQueued, 1);
  assert.equal(watch.status().lastErrorCode, '');
});

test('an upstream list failure returns a readable reason and keeps the bookkeeping intact', async () => {
  watch.configure({ enabled: true, memberId: ID });
  const startedAt = new Date().toISOString();
  watch._internals.setLister(async () => ({ list: [{ liveId: '9004', member: { id: ID }, startedAt }] }));
  intake.preview = async () => ({ previewId: 'pv2' });
  intake.confirm = () => ({ kind: 'import', job: { id: 'job2' } });
  await watch.tick(Date.now(), { force: true });
  const succeeded = watch.status();
  watch._internals.setLister(async () => { throw Object.assign(new Error('socket hang up'), { code: 'pocket48_replay_list_failed' }); });
  const result = await watch.tick(Date.now(), { force: true });
  assert.deepEqual(result, { queued: 0, upstreamError: UNREACHABLE });
  assert.equal(watch.status().lastErrorCode, 'pocket48_replay_list_failed');
  assert.equal(watch.status().lastSuccessAt, succeeded.lastSuccessAt, 'a failed list fetch is not a successful poll');
  assert.equal(watch.status().lastQueued, succeeded.lastQueued, 'the failure does not reset the last queued count');
});

test('the manual run route flattens queued and upstreamError onto the watch status', async () => {
  const express = require('express');
  const app = express();
  app.use(require('../routes/pocket48-account'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    watch.configure({ enabled: true, memberId: ID });
    watch._internals.setLister(async () => ({ list: [] }));
    let response = await fetch(`http://127.0.0.1:${server.address().port}/replay-watch/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    const ok = (await response.json()).data;
    assert.equal(ok.enabled, true);
    assert.equal(ok.queued, 0);
    assert.equal(ok.upstreamError, undefined);
    const stamped = Date.parse(ok.lastAttemptAt);
    assert.ok(stamped <= Date.now() + 1000, 'the manual run records the real attempt time');
    assert.ok(Math.abs(Date.parse(ok.nextAt) - (stamped + watch._internals.DAY_MS)) < 1000, 'the next automatic sweep is tomorrow, not the day after');
    watch._internals.setLister(async () => { throw new Error('boom'); });
    response = await fetch(`http://127.0.0.1:${server.address().port}/replay-watch/run`, { method: 'POST' });
    assert.equal(response.status, 200);
    const failed = (await response.json()).data;
    assert.equal(failed.queued, 0);
    assert.equal(failed.upstreamError, UNREACHABLE);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
