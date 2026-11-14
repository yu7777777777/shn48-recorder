'use strict';
// Read-only audit probes. Reads source text only; ALL audited filesystem, store,
// child process, network, timers and side-effectful application modules are mocked.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const workspace = path.resolve(__dirname, '../..');
function load(relative, deps) {
  const filename = path.join(workspace, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) { if (!(name in deps)) throw Error('Unmocked dependency: ' + name); return deps[name]; },
    console, process: { env: {} },
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename });
  return module.exports;
}
async function retentionWindow() {
  const root = path.resolve('C:/audit-in-memory/recordings');
  const main = path.join(root, 'archive.mp4'), raw = path.join(root, 'original.flv');
  const files = new Map([[main, { size: 1000, mtimeMs: 100 }], [raw, { size: 400, mtimeMs: 100 }]]);
  const records = [{ id: 'r', status: 'done', filePath: main, sourceFiles: [raw] }];
  const manager = { getRecordings: () => records, getQueue: () => [], updateRecording: (id, u) => Object.assign(records.find(r => r.id === id), u) };
  const stat = p => { const f = files.get(path.resolve(p)); if (!f) throw Error('missing'); return { ...f, isFile: () => true }; };
  const fakeFs = {
    realpathSync: p => path.resolve(p), statSync: stat, lstatSync: stat,
    existsSync: p => path.resolve(p) === root || files.has(path.resolve(p)),
    statfsSync: () => ({ bavail: 0n, bsize: 4096n }),
    unlinkSync: p => { if (!files.delete(path.resolve(p))) throw Error('missing'); },
    readdirSync: () => [...files.keys()].map(p => ({ name: path.basename(p), isFile: () => true, isDirectory: () => false })),
  };
  const leases = { lockedPath: () => false, lockedRecording: () => false }, noBusy = { busy: () => false };
  const storage = load('app/server/modules/recorder/storage.js', {
    fs: fakeFs, path, crypto: require('crypto'), './manager': manager, '../backup115/leases': leases,
    './replay-recovery': noBusy, '../analysis/service': noBusy, './clips': noBusy,
  });
  const retention = load('app/server/modules/recorder/retention.js', {
    fs: fakeFs, path, './manager': manager, './storage': storage,
    './replay-download': { verifyFull: async () => {} }, '../backup115/leases': leases,
    './replay-audit': noBusy, '../pocket48/recorder': { _internals: { recordingsDir: () => root } },
  });
  const now = Date.now();
  await retention.sweep(now);
  assert.equal(now - Date.parse(records[0].retentionVerifiedAt), 0);
  assert.equal(files.has(raw), true);
  const result = await retention.purge(root);
  assert.equal(files.has(raw), false, 'Observed defect: a zero-age verified archive lost its original');
  assert.equal(files.has(main), true);
  console.log(JSON.stringify({ probe: 'retention-window', verifiedAgeMsAtPurge: 0, result, originalExists: files.has(raw), mainExists: files.has(main) }));
}
async function restartOmission() {
  const root = path.resolve('C:/audit-in-memory/recordings');
  const old = path.join(root, 'before-restart.partial.flv'), fresh = path.join(root, 'after-restart.flv');
  const persisted = [{ id: 'owner', source: 'pocket48', liveId: '123', memberId: '1', memberName: 'member', liveTitle: 'test', title: 'test', status: 'recording', filePath: old, startedAt: '2026-10-23T09:00:00Z' }];
  const store = { load: (key, fallback) => key === 'recordings' ? JSON.parse(JSON.stringify(persisted)) : fallback, save() {}, atomicWrite() {}, filePath: k => k };
  const manager = load('app/server/modules/recorder/manager.js', { '../../lib/store': store, '../../lib/sse': { broadcast() {} } });
  const segment = manager.addRecording({ source: 'pocket48', liveId: '123', memberId: '1', memberName: 'member', title: 'test', liveTitle: 'test', status: 'waiting_merge', filePath: fresh, startedAt: '2026-10-23T09:05:00Z', endedAt: '2026-10-23T09:10:00Z' });
  const known = new Set([old, fresh]);
  const fakeFs = { existsSync: p => known.has(p), realpathSync: p => p, lstatSync: () => ({ isFile: () => true }), statSync: () => ({ size: 100 }), writeFileSync() {}, unlinkSync() {}, renameSync: (from, to) => known.add(to) };
  const calls = [];
  function spawn(bin, args) {
    calls.push({ bin, args });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stderr.resume = () => {};
    setImmediate(() => { if (bin === 'ffprobe') c.stdout.emit('data', JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 16, height: 16 }], format: { duration: '1' } })); c.emit('close', 0); });
    return c;
  }
  const recorder = { listActive: () => [], _internals: { recordingsDir: () => root, safeName: x => x } };
  const archive = load('app/server/modules/recorder/archive-processor.js', {
    fs: fakeFs, path, child_process: { spawn }, './manager': manager, '../pocket48/recorder': recorder,
    '../bilibili/queue': {}, '../backup115/leases': { lockedPath: () => false },
    './replay-recovery': { _internals: { needsQualityGate: () => false } }, './covers': { generate: async () => {} },
  });
  const result = await archive.processRecording(segment.id, { immediate: true, autoEnqueue: false });
  assert.equal(manager.getRecording('owner').status, 'failed');
  assert.equal(segment.sessionId, 'owner');
  assert.equal(result.status, 'done');
  assert.equal(result.sourceFiles.includes(old), false);
  assert.equal(result.sourceFiles.length, 1);
  assert.equal(result.sourceFiles[0], fresh);
  console.log(JSON.stringify({ probe: 'restart-omission', oldOwnerStatus: manager.getRecording('owner').status, newSegmentSessionId: segment.sessionId, newSegmentStatus: result.status, archiveSourceFiles: result.sourceFiles, oldPartialIncluded: result.sourceFiles.includes(old), oldPartialStillExists: known.has(old) }));
  console.log(JSON.stringify({ probe: 'restart-input-proof', mockFfmpegCommands: calls.filter(c => c.bin === 'ffmpeg') }));
}
async function staleReplayPlan() {
  const directory = path.resolve('C:/audit-in-memory/cache'), planFile = path.join(directory, 'plan.json');
  const plan = { liveId: '123', resources: [{ name: 'asset-00000.ts', url: 'https://cdn.example/replay.ts?expired=1' }], completed: {}, scope: { origin: 'https://cdn.example', hostname: 'cdn.example', pathPrefix: '/', resourcePathPrefixes: ['/'] }, local: '#EXTM3U', seconds: 10 };
  const fakeFs = { mkdirSync() {}, existsSync: p => p === planFile, readFileSync: () => JSON.stringify(plan), statfsSync: () => ({ bavail: 100000000n, bsize: 4096n }), unlinkSync() {} };
  let lookups = 0; const requests = [];
  const media = load('app/server/modules/recorder/replay-download.js', {
    fs: fakeFs, path, crypto: require('crypto'), 'stream/promises': require('stream/promises'), stream: require('stream'),
    child_process: { spawn() { throw Error('spawn forbidden'); } }, '../../lib/store': { atomicWrite() { throw Error('write forbidden'); } },
    '../pocket48/replay-proxy': { _internals: {} }, '../pocket48/replay': {},
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    let failure;
    try { await media.download({ liveId: '123', directory, getReplay: async () => { lookups++; return { streamUrl: 'https://cdn.example/fresh.m3u8' }; }, request: async url => { requests.push(url); return { response: { statusCode: 403, resume() {} } }; } }); }
    catch (error) { failure = error; }
    assert.ok(failure);
    console.log(JSON.stringify({ probe: 'stale-plan-attempt', attempt, error: failure.message, getReplayCalls: lookups, resourceRequests: requests.length }));
  }
  assert.equal(lookups, 0); assert.equal(requests.length, 6);
  assert.ok(requests.every(x => x.includes('expired=1')));
}
(async () => { await retentionWindow(); await restartOmission(); await staleReplayPlan(); console.log('All isolated audit probes reproduced the observed behaviors; no application files/data were changed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
