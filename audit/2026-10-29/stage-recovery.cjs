'use strict';
// Stage replay recovery on the host disk (persists across container restarts, far from the
// recorder's RECORDINGS_DIR). Leaf modules only: no manager/import/recovery boot.
const fs = require('fs'), path = require('path');
const ROOT = '/opt/shn48/recovery-preserved';
const PREVIOUS = '/app/data/recovery-20261026-29';
for (const d of ['/opt/shn48/recovery-preserved/state', '/opt/shn48/recovery-preserved/home', '/opt/shn48/recovery-preserved/download']) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
process.env.DATA_DIR = ROOT + '/state';
process.env.POCKET48_DATA_DIR = ROOT + '/state';
process.env.HOME = ROOT + '/home';
process.env.RECORDINGS_DIR = '/opt/shn48/recovery-preserved/unused-recordings';
const media = require('/app/server/modules/recorder/replay-download');
const replay = require('/app/server/modules/pocket48/replay');
const proxy = require('/app/server/modules/pocket48/replay-proxy')._internals;
const LIVE = [{ liveId: '1321966661005021184', memberId: '64422010', memberName: '熊紫轶', title: '你好的坏的', startedAt: '2026-10-27T14:23:33.633Z', durationSeconds: 9704 }, { liveId: '1322332610476445696', memberId: '64422010', memberName: '熊紫轶', title: '你好的坏的', startedAt: '2026-10-28T14:37:42.806Z', durationSeconds: 10214 }];
const THRESHOLD = 6 * 2 ** 30;
function free() { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; }
function guard(extra = 0) { const f = free(); if (f < THRESHOLD + extra) throw Object.assign(new Error('暂缓：为直播预留6GiB空间'), { code: 'RECOVERY_RESERVE', freeGiB: +(f / 2 ** 30).toFixed(2) }); return f; }
function emit(x) { console.log(JSON.stringify({ at: new Date().toISOString(), ...x })); }
// Reuse already-verified segments when identical names/sizes exist so the retry does not re-download.
function adopt(liveId) {
  const from = path.join(PREVIOUS, liveId), to = path.join(ROOT, 'download', liveId);
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  let n = 0;
  if (fs.existsSync(from)) for (const name of fs.readdirSync(from)) {
    if (!/^asset-\d{5}\.[a-z0-9]{1,8}$/i.test(name)) continue;
    const src = path.join(from, name), dst = path.join(to, name);
    try { if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst); n += 1; } catch {}
  }
  return n;
}
(async () => {
  const out = { startedAt: new Date().toISOString(), staging: ROOT, results: [] };
  emit({ event: 'started', freeGiB: +(free() / 2 ** 30).toFixed(2), thresholdGiB: 6 });
  for (const meta of LIVE) {
    guard();
    const dir = path.join(ROOT, meta.liveId);
    if (fs.existsSync(dir + '/complete.json') && fs.existsSync(dir + '/verified.mp4')) { const c = JSON.parse(fs.readFileSync(dir + '/complete.json')); if (c.verification === 'full') { out.results.push({ ...meta, status: 'preserved', size: c.size, sha256: c.sha256, filePath: dir + '/verified.mp4' }); emit({ event: 'already_preserved', liveId: meta.liveId }); continue; } }
    const adopted = adopt(meta.liveId);
    emit({ event: 'download_start', liveId: meta.liveId, durationSeconds: meta.durationSeconds, adoptedSegments: adopted, freeGiB: +(free() / 2 ** 30).toFixed(2) });
    try {
      const official = await media.download({
        liveId: meta.liveId, directory: dir, verify: true,
        request: async (...args) => { guard(); return proxy.upstreamRequest(...args); },
        onProgress(p) {
          guard(p.verifying ? Math.ceil(p.bytes * 1.1) : 0);
          const pct = p.total ? Math.floor(p.completed / p.total * 100) : 0;
          if (p.verifying || pct % 20 === 0) emit({ event: p.verifying ? 'verifying' : 'progress', liveId: meta.liveId, pct, bytes: p.bytes, freeGiB: +(free() / 2 ** 30).toFixed(2) });
          else if (pct % 20 === 0) emit({ event: 'progress', liveId: meta.liveId, pct, bytes: p.bytes, freeGiB: +(free() / 2 ** 30).toFixed(2) });
        },
      });
      if (official.verification !== 'full' || !fs.existsSync(official.filePath) || fs.statSync(official.filePath).size !== official.size || Math.abs(official.durationSeconds - meta.durationSeconds) > Math.max(3, meta.durationSeconds * 0.005)) throw Object.assign(new Error('媒体完整性和时长未对齐'), { code: 'RECOVERY_VALIDATION' });
      const row = { ...meta, status: 'preserved', size: official.size, sha256: official.sha256, durationSeconds: official.durationSeconds, verification: official.verification, filePath: official.filePath, archiveRegistered: false, preservedAt: new Date().toISOString() };
      out.results.push(row); media.atomicJson(ROOT + '/results.json', out); emit({ event: 'preserved', liveId: meta.liveId, size: official.size, sha256: official.sha256, freeGiB: +(free() / 2 ** 30).toFixed(2) });
    } catch (e) {
      out.results.push({ ...meta, status: 'failed', code: e.code || e.name, message: /^[\u4e00-\u9fff]/.test(e.message || '') ? e.message : '下载处理失败' });
      emit({ event: 'failed', liveId: meta.liveId, code: e.code || e.name, message: /^[\u4e00-\u9fff]/.test(e.message || '') ? e.message : '下载处理失败', freeGiB: +(free() / 2 ** 30).toFixed(2) });
      if ((e.code || '').startsWith('RECOVERY_')) break;
    }
  }
  out.finishedAt = new Date().toISOString(); media.atomicJson(ROOT + '/results.json', out);
  emit({ event: 'finished', results: out.results.map(({ liveId, status, size }) => ({ liveId, status, size })), freeGiB: +(free() / 2 ** 30).toFixed(2) });
  process.exit(0);
})().catch(e => { emit({ event: 'fatal', code: e.code || e.name }); process.exit(1); });
