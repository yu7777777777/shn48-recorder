"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-storage-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.RECORDINGS_DIR = path.join(root, 'recordings');
fs.mkdirSync(process.env.RECORDINGS_DIR);
const manager = require('../modules/recorder/manager');
const routes = require('../routes/recordings');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('one archive exposes six physical files; cleanup and archive deletion reclaim all originals', async () => {
  const files = ['main.mp4', 'a.flv', 'b.flv', 'c.flv', 'old-a.flv', 'old-b.flv'].map(name => {
    const file = path.join(process.env.RECORDINGS_DIR, name); fs.writeFileSync(file, '12345'); return file;
  });
  manager.addRecording({ id: 'main', status: 'done', filePath: files[0], sourceFiles: files.slice(1, 4) });
  manager.addRecording({ id: 'old', status: 'deleted', filePath: null, sourceFiles: files.slice(4) });
  const app = express(); app.use('/', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${base}/storage`)).json()).data;
  try {
    assert.equal(manager.getRecordings().length, 1);
    let data = await get();
    assert.equal(data.fileCount, 6); assert.equal(data.totalBytes, 30); assert.equal(data.extraBytes, 25);
    assert.ok(data.files.every(f => !f.filePath));
    const remove = id => fetch(`${base}/storage/${id}`, { method: 'DELETE' });
    assert.equal((await remove(data.files.find(f => f.kind === 'main').id)).status, 409);
    manager.updateRecording('main', { status: 'processing' });
    assert.equal((await remove(data.files.find(f => f.kind === 'source').id)).status, 409);
    manager.updateRecording('main', { status: 'done' });
    const shared = manager.addRecording({ id: 'shared', status: 'done', filePath: files[1] });
    // `shared` uses a.flv as its own main file. Deleting `main` is allowed: a.flv
    // is still referenced by `shared`, so it is detached from `main` and kept on
    // disk rather than unlinked. Refusing the delete here is what made duplicate
    // archives of one live impossible to clean up.
    assert.equal((await fetch(`${base}/main`, { method: 'DELETE' })).status, 200);
    assert.ok(fs.existsSync(files[0]) === false, 'the deleted archive main file is reclaimed');
    assert.ok(fs.existsSync(files[1]), 'a file still owned by another archive is kept');
    manager.updateRecording(shared.id, { status: 'deleted', filePath: null });
    assert.ok(files.slice(2,4).every(f => !fs.existsSync(f)));
    // files[4], files[5] are the deleted archive's residues; files[1] survives as
    // the detached file above. All three are still accounted for and reclaimable.
    data = await get(); assert.equal(data.fileCount, 3);
    for (const f of data.files) assert.equal((await remove(f.id)).status, 200);
    fs.writeFileSync(path.join(process.env.RECORDINGS_DIR, 'orphan.flv'), '123');
    data = await get(); assert.equal(data.files[0].kind, 'untracked');
    assert.equal((await remove(data.files[0].id)).status, 200);
    assert.equal((await get()).fileCount, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
