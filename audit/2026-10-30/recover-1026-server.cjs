'use strict';
// Re-download the 2026-10-26 missing replay directly on the server.
// Leaf modules only: never load recorder manager / import jobs / recovery scanner.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = '/opt/shn48/recovery-preserved';
for (const d of ['state', 'home', 'download']) fs.mkdirSync(path.join(ROOT, d), { recursive: true, mode: 0o700 });
process.env.DATA_DIR = ROOT + '/state';
process.env.POCKET48_DATA_DIR = ROOT + '/state';
process.env.HOME = ROOT + '/home';
process.env.RECORDINGS_DIR = ROOT + '/unused-recordings';
const media = require('/app/server/modules/recorder/replay-download');
const replay = require('/app/server/modules/pocket48/replay');
const proxy = require('/app/server/modules/pocket48/replay-proxy')._internals;
const META = { liveId: '1321554233301733376', memberId: '87622891', memberName: '刘小涵', title: '❤️聊天', startedAt: '2026-10-26T11:04:42.961Z', durationSeconds: 6967 };
const THRESHOLD = 4 * 2 ** 30;
const free = () => { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; };
const guard = (extra = 0) => { const f = free(); if (f < THRESHOLD + extra) throw Object.assign(new Error('暂缓：为直播预留4GiB空间'), { code: 'RECOVERY_RESERVE', freeGiB: +(f / 2 ** 30).toFixed(2) }); };
const emit = x => console.log(JSON.stringify({ at: new Date().toISOString(), ...x }));
(async () => {
  const dir = path.join(ROOT, META.liveId);
  emit({ event: 'started', liveId: META.liveId, freeGiB: +(free() / 2 ** 30).toFixed(2), thresholdGiB: 4 });
  guard();
  let lastPct = -1;
  try {
    const official = await media.download({
      liveId: META.liveId, directory: dir, verify: true,
      request: async (...args) => { guard(); return proxy.upstreamRequest(...args); },
      onProgress(p) {
        guard(p.verifying ? Math.ceil(p.bytes * 1.1) : 0);
        const pct = p.total ? Math.floor(p.completed / p.total * 100) : 0;
        if (p.verifying || pct >= lastPct + 10) { lastPct = pct; emit({ event: p.verifying ? 'verifying' : 'progress', pct, bytes: p.bytes, freeGiB: +(free() / 2 ** 30).toFixed(2) }); }
      },
    });
    const hash = crypto.createHash('sha256').update(fs.readFileSync(official.filePath)).digest('hex');
    if (official.verification !== 'full' || hash !== official.sha256 || fs.statSync(official.filePath).size !== official.size
      || Math.abs(official.durationSeconds - META.durationSeconds) > Math.max(3, META.durationSeconds * 0.005)) {
      throw Object.assign(new Error('媒体完整性和时长未对齐'), { code: 'RECOVERY_VALIDATION' });
    }
    const results = (() => { try { return JSON.parse(fs.readFileSync(ROOT + '/results.json', 'utf8')); } catch { return { results: [] }; } })();
    const row = { ...META, status: 'preserved', size: official.size, sha256: official.sha256, durationSeconds: official.durationSeconds, verification: official.verification, filePath: official.filePath, archiveRegistered: false, preservedAt: new Date().toISOString(), source: 'server-redownload' };
    results.results = (results.results || []).filter(r => r.liveId !== META.liveId).concat([row]);
    results.finishedAt = new Date().toISOString();
    media.atomicJson(ROOT + '/results.json', results);
    fs.writeFileSync(dir + '/recovery-metadata.json', JSON.stringify(row, null, 2));
    emit({ event: 'preserved', ...row, freeGiB: +(free() / 2 ** 30).toFixed(2) });
    process.exit(0);
  } catch (e) {
    emit({ event: 'failed', code: e.code || e.name, message: /^[\u4e00-\u9fff]/.test(e.message || '') ? e.message : '下载处理失败', freeGiB: +(free() / 2 ** 30).toFixed(2) });
    process.exit(2);
  }
})().catch(e => { emit({ event: 'fatal', code: e.code || e.name }); process.exit(1); });
