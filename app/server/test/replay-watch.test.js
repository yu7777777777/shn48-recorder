'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.POCKET48_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'watch-'));
const watch = require('../modules/pocket48/replay-watch');
const ID = '482000000000000001';

const item = (liveId, memberId, startedAt) => ({ liveId, member: { id: memberId }, startedAt });

test('only replays inside the window, belonging to the member and not yet archived are picked', () => {
  const since = Date.parse('2026-10-01T00:00:00Z');
  const picked = watch.select([
    item('1', ID, '2026-10-02T00:00:00Z'),
    item('2', ID, '2026-09-01T00:00:00Z'),
    item('3', '999', '2026-10-03T00:00:00Z'),
    item('4', ID, '2026-10-04T00:00:00Z'),
    item('5', ID, '2026-10-05T00:00:00Z'),
    item('6', ID, ''),
    item('', ID, '2026-10-06T00:00:00Z'),
  ], { memberId: ID, since, archived: ['4'], active: ['5'] });
  assert.deepEqual(picked, ['1']);
});

test('a replay is never queued twice inside one decision', () => {
  const since = Date.parse('2026-10-01T00:00:00Z');
  const row = item('7', ID, '2026-10-02T00:00:00Z');
  assert.deepEqual(watch.select([row, row], { memberId: ID, since }), ['7']);
});

test('the watch refuses to arm without a numeric member id', () => {
  assert.throws(() => watch.configure({ enabled: true, memberId: 'abc' }), /成员 ID/);
  assert.throws(() => watch.configure({ enabled: 'yes' }), /开关无效/);
});

test('arming starts the window now and disarming clears the attempt clock', () => {
  const armed = watch.configure({ enabled: true, memberId: ID, memberName: '测试成员' });
  assert.equal(armed.enabled, true);
  assert.ok(Date.parse(armed.enabledAt) <= Date.now());
  assert.equal(armed.nextAt, null, 'no attempt yet, so nothing is scheduled');
  const off = watch.configure({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.lastAttemptAt, null);
});

test('an attempt is stamped before the request so a crash cannot hot-loop', async () => {
  watch.configure({ enabled: true, memberId: ID });
  let calls = 0;
  watch._internals.setLister(async () => { calls += 1; throw Object.assign(new Error('boom'), { code: 'pocket48_replay_list_failed' }); });
  const result = await watch.tick(Date.now());
  assert.equal(result.queued, 0);
  assert.equal(calls, 1);
  assert.equal(watch.status().lastErrorCode, 'pocket48_replay_list_failed');
  const again = await watch.tick(Date.now() + 60_000);
  assert.equal(calls, 1, 'a second tick inside the same day does not call upstream again');
  assert.equal(again.queued, 0);
});
