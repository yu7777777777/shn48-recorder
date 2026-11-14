
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// FIXTURE-ROOMSTATE — 246 of 531 members have a revoked channel upstream. The
// roster must say so per row instead of letting the click fail.
test('room state separates readable channels from revoked ones and survives a cache round trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-state-'));
  process.env.DATA_DIR = dir;
  for (const key of Object.keys(require.cache)) if (key.includes(path.sep + 'room-state.js')) delete require.cache[key];
  const roomState = require('../modules/pocket48/room-state');
  const asked = [];
  const api = {
    async getRoomMessages(roomId) {
      asked.push(roomId);
      if (roomId === '111') return { status: 200, data: { status: 200, content: { message: [] } } };
      if (roomId === '222') return { status: 200, data: { status: 500, message: '频道不存在' } };
      throw new Error('network down');
    },
  };
  try {
    const states = await roomState.states(api, ['111', '222', '333'], { refresh: true });
    assert.equal(states['111'], 'ok');
    assert.equal(states['222'], 'gone');
    assert.equal(states['333'], 'unknown', 'a throwing probe must not claim the room is gone');
    // a second call inside the TTL must not hit the upstream again
    const before = asked.length;
    await roomState.states(api, ['111', '222', '333']);
    assert.equal(asked.length, before, 'a warm cache must not re-probe');
    // and the cache is on disk, so a restart keeps the labels
    roomState._reset();
    const reloaded = await roomState.states(api, ['111', '222', '333']);
    assert.equal(reloaded['222'], 'gone');
    assert.equal(asked.length, before, 'a reloaded cache must not re-probe');
  } finally { delete process.env.DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
});
