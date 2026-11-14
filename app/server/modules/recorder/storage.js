const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manager = require('./manager');
const backupLeases = require('../backup115/leases');
const activeStatuses = ['recording', 'waiting_merge', 'processing'];
const mediaPattern = /\.(mp4|flv|mkv|ts|webm|mov|avi|m4v|m4a|mp3|wav)$/i;
// TTL cache for the polling endpoint: `inventory(root, { cache: true })` reuses a
// result from the last 3s for the same root. Deletion decisions (retention purge,
// DELETE /storage/:fileId) never pass `cache`, so they always scan fresh.
const INVENTORY_CACHE_MS = 3000;
const inventoryCache = new Map();
function paths(rec) { return [...new Set([rec.filePath, rec.replayRecovery?.replayFilePath, ...(rec.sourceFiles || [])].filter(Boolean).map(p => path.resolve(p)))]; }
function locked(rec) {
  return backupLeases.lockedRecording(rec) || require('./replay-recovery').busy(rec.id) || activeStatuses.includes(rec.status) || manager.getQueue().some(q => String(q.recordingId) === String(rec.id) && ['queued', 'waiting_credentials', 'uploading', 'paused_recording'].includes(q.status));
}
// One pass over all records per inventory run instead of `records.filter(...)`
// per file: resolved path -> owners, so the per-file side is an O(1) lookup.
function ownersByPath(records) {
  const map = new Map();
  for (const rec of records) for (const p of paths(rec)) {
    const owners = map.get(p);
    if (owners) owners.push(rec); else map.set(p, [rec]);
  }
  return map;
}
async function inventory(root, options = {}) {
  const cacheKey = path.resolve(root);
  if (options.cache) {
    const hit = inventoryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < INVENTORY_CACHE_MS) return hit.data;
  }
  const records = manager.getRecordings({ includeDeleted: true, includeMerged: true });
  const owners = ownersByPath(records);
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(filePath); continue; }
      if (!entry.isFile() || !mediaPattern.test(entry.name)) continue;
      const relativeName = path.relative(root, filePath).split(path.sep);
      if (relativeName[0] === '.official-replays' && (/^asset-\d{5}\.[a-z0-9]{1,8}(?:\.part)?$/i.test(entry.name) || ['local.m3u8', 'replay.processing.mp4'].includes(entry.name))) continue;
      const fileOwners = owners.get(path.resolve(filePath)) || [];
      const main = fileOwners.find(r => r.status !== 'deleted' && r.status !== 'merged' && path.resolve(r.filePath || '.') === filePath);
      const kind = main ? 'main' : fileOwners.some(r => !['deleted', 'merged'].includes(r.status)) ? 'source' : fileOwners.length ? 'residual' : 'untracked';
      const stat = await fs.promises.stat(filePath);
      const replayOwner = relativeName[0] === '.official-replays' ? records.find(r => String(r.liveId) === path.basename(path.dirname(filePath)) && require('./replay-recovery').busy(r.id)) : null;
      files.push({ id: crypto.createHash('sha256').update(path.relative(root, filePath)).digest('hex'), filePath, name: path.relative(root, filePath), size: stat.size, kind, recordingTitle: fileOwners[0]?.title || '', locked: backupLeases.lockedPath(filePath) || Boolean(replayOwner) || fileOwners.some(locked) || (!fileOwners.length && records.some(r => activeStatuses.includes(r.status))) });
    }
  }
  if (fs.existsSync(root)) await walk(root);
  const data = { files, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0), extraBytes: files.filter(f => f.kind !== 'main').reduce((n, f) => n + f.size, 0) };
  if (options.cache) inventoryCache.set(cacheKey, { at: Date.now(), data });
  return data;
}
// Drops the cached inventory for a root. Delete routes call this after a
// successful deletion so the next polling scan does not serve the removed file
// for the remainder of the TTL window.
function invalidate(root) { inventoryCache.delete(path.resolve(root)); }
module.exports = { inventory, paths, locked, invalidate };
