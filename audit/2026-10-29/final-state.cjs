'use strict';
const fs = require('fs');
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const root = '/opt/shn48/recovery-preserved';
const stat = fs.statfsSync(root || '/');
const records = read('/app/data/recordings.json', []);
const preserved = read(root + '/results.json', {});
const keep = (id) => { const d = `${root}/download/${id}`; try { return fs.readdirSync(d).filter(f => /^asset-\d{5}\.[a-z0-9]{1,8}$/i.test(f)).length; } catch { return 0; } };
const out = {
  sampledAt: new Date().toISOString(),
  host: require('os').hostname(),
  version: fs.readFileSync('/app/VERSION', 'utf8').trim(),
  freeGiB: +(stat.bavail * stat.bsize / 2 ** 30).toFixed(2),
  diskTotalGiB: +(stat.blocks * stat.bsize / 2 ** 30).toFixed(2),
  activeRecordings: records.filter(r => r.status === 'recording').map(r => ({ id: r.id, liveId: r.liveId, memberName: r.memberName, title: r.title, startedAt: r.startedAt })),
  preserved: (preserved.results || []).map(({ liveId, status, size, sha256, verification }) => ({ liveId, status, size, sha256, verification })),
  cachedSegments: { '1321966661005021184': keep('1321966661005021184'), '1322332610476445696': keep('1322332610476445696') },
  verifiedMaster: (() => { try { const p = `${root}/1321554233301733376/verified.mp4`; const c = read(`${root}/1321554233301733376/complete.json`, null); return { exists: fs.existsSync(p), size: fs.existsSync(p) ? fs.statSync(p).size : null, manifest: c && { size: c.size, sha256: c.sha256, verification: c.verification } }; } catch { return { exists: false }; } })(),
};
console.log(JSON.stringify(out));
