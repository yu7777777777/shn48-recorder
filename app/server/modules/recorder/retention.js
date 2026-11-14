"use strict";
const fs = require("fs");
const path = require("path");
const manager = require("./manager");
const storage = require("./storage");
const media = require("./replay-download");
const backupLeases = require("../backup115/leases");
const DAY = 86400000;
const GiB = 1024 ** 3;
// Reclaiming starts below the reserve line and stops above the target line, so a
// sweep does not oscillate around a single threshold.
const DEFAULT_RESERVE_GIB = 8;
const DEFAULT_TARGET_GIB = 12;
let timer;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function config() {
  const reserve = numberFromEnv("STORAGE_RESERVE_GIB", DEFAULT_RESERVE_GIB);
  return {
    reserveBytes: reserve * GiB,
    // The target must stay above the reserve line or the purge would never stop.
    targetBytes: Math.max(reserve, numberFromEnv("STORAGE_TARGET_GIB", Math.max(DEFAULT_TARGET_GIB, reserve))) * GiB,
  };
}
function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir, { bigint: true });
    return Number(stat.bavail * stat.bsize);
  } catch { return Number.POSITIVE_INFINITY; }
}

function dropReference(filePath, records) {
  // Remove the reference from every owner, including merged segment records, so
  // no page keeps pointing at a file that is gone.
  for (const owner of records) {
    if (!storage.paths(owner).includes(filePath)) continue;
    const update = { sourceFiles: (owner.sourceFiles || []).filter((p) => path.resolve(p) !== filePath) };
    if (owner.replayRecovery?.replayFilePath && path.resolve(owner.replayRecovery.replayFilePath) === filePath) {
      update.replayRecovery = { ...owner.replayRecovery, replayFilePath: null };
    }
    manager.updateRecording(owner.id, update);
  }
}

// A path that any record owns as its main file is never reclaimable, whatever
// else it is referenced as. Verified official replays live at
// `.official-replays/<liveId>/verified.mp4`, which looks exactly like cache to the
// old code — and `sweep()` additionally treated `replayRecovery.replayFilePath` as
// reclaimable, so the verified main file of an official_replay archive could be
// deleted. That is what removed five finished archives on 2026-10-26.
//
// Returns a predicate over absolute paths. `includeDeleted` is false on purpose:
// a deleted record must not resurrect its file into the protected set forever.
function mainFileGuard(records) {
  const owned = new Set();
  for (const rec of records) {
    if (!rec || rec.status === "deleted" || rec.status === "merged") continue;
    if (rec.filePath) owned.add(path.resolve(rec.filePath));
  }
  return (filePath) => owned.has(path.resolve(filePath));
}

async function sweep(now = Date.now()) {
  const root = fs.realpathSync(require("../pocket48/recorder")._internals.recordingsDir());
  const records = manager.getRecordings({ includeDeleted: true, includeMerged: true });
  const isMainFile = mainFileGuard(records);
  const protectedFiles = new Set(records.filter(r => !["deleted", "merged"].includes(r.status)).map(r => path.resolve(r.filePath || root)));
  for (const q of manager.getQueue().filter(q => ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(q.status))) if (q.file) protectedFiles.add(path.resolve(q.file));
  let bytes = 0, files = 0;
  const safe = file => {
    const full = path.resolve(file);
    if (!full.startsWith(root + path.sep)) return false;
    try { return fs.realpathSync(full) === full && fs.lstatSync(full).isFile(); } catch { return false; }
  };
  for (const rec of records) {
    if (rec.status !== "done" || storage.locked(rec) || require("./replay-audit").busy(rec.id) || !safe(rec.filePath) || fs.statSync(rec.filePath).size <= 0) continue;
    // New archives receive a full retention window after successful verification.
    // Existing archives start that window when first seen, rather than being deleted on deployment.
    const currentStat = fs.statSync(rec.filePath);
    const fingerprint = { path: rec.filePath, size: currentStat.size, mtimeMs: currentStat.mtimeMs };
    if (!rec.retentionVerifiedAt || JSON.stringify(rec.retentionFingerprint) !== JSON.stringify(fingerprint)) {
      const state = rec.replayRecovery?.status;
      if (["pending", "downloading", "verifying", "waiting_replay", "awaiting_archive"].includes(state)) continue;
      try { await media.verifyFull(rec.filePath); } catch { continue; }
      if (storage.locked(rec) || require("./replay-audit").busy(rec.id)) continue;
      manager.updateRecording(rec.id, { retentionVerifiedAt: new Date(now).toISOString(), retentionFingerprint: fingerprint });
      continue;
    }
    if (now - Date.parse(rec.retentionVerifiedAt) < DAY) continue;
    // Source fragments plus a leftover replay cache are reclaimable — but for an
    // official_replay archive, `replayRecovery.replayFilePath` IS `filePath` (the
    // verified main file), not a cache. It is filtered out by name first and then
    // again by isMainFile() before anything is unlinked.
    const candidates = [...new Set([...(rec.sourceFiles || []), rec.replayRecovery?.replayFilePath].filter(Boolean))]
      .filter(file => path.basename(file) !== "verified.mp4");
    for (const file of candidates) {
      const full = path.resolve(file);
      if (protectedFiles.has(full) || !safe(full) || records.some(r => r.id !== rec.id && storage.paths(r).includes(full) && storage.locked(r))) continue;
      // Never delete a file that is some record's main archive, even when the same
      // path is also referenced as a replay cache.
      if (isMainFile(full)) continue;
      if (path.resolve(rec.filePath || "") === full) continue;
      const size = fs.statSync(full).size;
      if (backupLeases.lockedPath(full) || backupLeases.lockedRecording(rec)) continue;
      fs.unlinkSync(full); bytes += size; files++;
      // Remove stale references from every owner, including merged segment records.
      for (const owner of records.filter(r => storage.paths(r).includes(full))) {
        const update = { sourceFiles: (owner.sourceFiles || []).filter(p => path.resolve(p) !== full) };
        if (owner.replayRecovery?.replayFilePath && path.resolve(owner.replayRecovery.replayFilePath) === full) update.replayRecovery = { ...owner.replayRecovery, replayFilePath: null };
        manager.updateRecording(owner.id, update);
      }
    }
  }
  const cache = path.join(root, ".official-replays");
  if (fs.existsSync(cache) && fs.realpathSync(cache) === cache) for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const dir = path.join(cache, entry.name);
    if (fs.realpathSync(dir) !== dir) continue;
    const owners = records.filter(r => String(r.liveId) === entry.name);
    if (owners.some(r => storage.locked(r) || require("./replay-audit").busy(r.id))) continue;
    const transient = fs.readdirSync(dir).filter(n => /^asset-\d{5}\.[a-z0-9]{1,8}(?:\.part)?$/i.test(n) || ["local.m3u8", "replay.processing.mp4", "plan.json"].includes(n));
    if (!transient.length || transient.some(n => !safe(path.join(dir, n)))) continue;
    // An explicit allow-list already excludes verified.mp4, but a main file must be
    // refused by construction rather than by a name pattern: if any transient name
    // doubles as an owner's main file, keep the whole directory untouched.
    if (fs.readdirSync(dir).some(n => isMainFile(path.join(dir, n)))) continue;
    const newest = Math.max(...transient.map(n => fs.statSync(path.join(dir, n)).mtimeMs));
    if (now - newest < DAY) continue;
    const transientBytes = transient.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    if (transient.some(n => backupLeases.lockedPath(path.join(dir, n)))) continue;
    files += media.cleanupTransient(dir);
    bytes += transientBytes;
  }
  if (files) console.log(`[retention] removed ${files} duplicate/cache files (${bytes} bytes)`);
  return { files, bytes };
}

// Water-level purge. The operator keeps every archive main file and removes them
// by hand, so this pass only reclaims fragments and cache until the target line.
// A broken archive is decoded once per process, not on every sweep: re-verifying
// a large file every ten minutes would cost more than it reclaims.
const brokenMemo = new Set();
async function purge(root) {
  const limits = config();
  const free = freeBytes(root);
  if (free >= limits.reserveBytes) return { files: 0, bytes: 0, free, skipped: "above-reserve" };
  const records = manager.getRecordings({ includeDeleted: true, includeMerged: true });
  // Fragments of an archive whose main file failed verification are the last
  // complete copy; that archive's fragments are never reclaimed by the purge.
  const brokenArchives = new Set();
  const heldArchives = new Set();
  for (const rec of records) {
    if (rec.status !== "done" || !rec.filePath) continue;
    // An archive that has not served its verified retention window yet keeps its
    // fragments: only the main file is known good, and deleting the source is
    // sweep()'s decision, made after that window elapses.
    const verifiedAt = Date.parse(rec.retentionVerifiedAt || "");
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt < DAY) { heldArchives.add(rec.id); continue; }
    const state = rec.replayRecovery?.status;
    if (["pending", "downloading", "verifying", "waiting_replay", "awaiting_archive"].includes(state)) continue;
    const fingerprint = `${rec.filePath}|${rec.size || 0}`;
    if (brokenMemo.has(fingerprint)) { brokenArchives.add(rec.id); continue; }
    try {
      await media.verifyFull(rec.filePath);
      brokenMemo.delete(fingerprint);
    } catch { brokenArchives.add(rec.id); brokenMemo.add(fingerprint); }
  }
  const brokenFiles = new Set();
  for (const rec of records) {
    if (!brokenArchives.has(rec.id) && !heldArchives.has(rec.id)) continue;
    for (const file of storage.paths(rec)) brokenFiles.add(path.resolve(file));
  }
  // `Promise.resolve` keeps injected synchronous inventory stubs (tests) and the
  // real async inventory compatible — deletion decisions always scan fresh here.
  const { files: inventory } = await Promise.resolve(storage.inventory(root));
  const queueFiles = new Set(manager.getQueue()
    .filter((q) => ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(q.status))
    .map((q) => path.resolve(q.file || "")));
  // Same guarantee as sweep(): a record's main archive is never reclaimed, even if
  // the inventory misclassifies it (`.official-replays/<liveId>/verified.mp4` is
  // both a main file and a replay path, which is how this purge deleted finished
  // archives on 2026-10-26).
  const isMainFile = mainFileGuard(records);
  const candidates = inventory
    .filter((file) => file.kind !== "main")
    .filter((file) => !file.locked)
    .filter((file) => path.basename(file.filePath) !== "verified.mp4")
    .filter((file) => !isMainFile(file.filePath))
    .filter((file) => !brokenFiles.has(path.resolve(file.filePath)))
    .filter((file) => !queueFiles.has(path.resolve(file.filePath)))
    .sort((a, b) => a.size - b.size);
  let bytes = 0, files = 0, current = free;
  for (const file of candidates) {
    if (current >= limits.targetBytes) break;
    try {
      const size = fs.statSync(file.filePath).size;
      if (backupLeases.lockedPath(file.filePath)) continue;
      fs.unlinkSync(file.filePath);
      dropReference(path.resolve(file.filePath), records);
      current += size; bytes += size; files++;
    } catch { /* A file that vanished or is unreadable is simply skipped. */ }
  }
  if (files) console.log(`[retention] water-level purge removed ${files} fragment/cache files (${bytes} bytes, free ${current})`);
  return { files, bytes, free: current, broken: brokenArchives.size };
}

// On-demand reclaim for the automatic recorder. A live is starting and the disk
// is below what that recording plausibly needs: reclaim whatever is safe right
// now, without waiting for the 10-minute water-level timer. Returns how much free
// space remains so the caller can decide whether the start is still refused.
//
// Deliberately conservative: only fragments and cache that `inventory` already
// classifies as non-main, unlocked and untracked-or-residual. Archive main files
// are never touched here — the operator keeps those on purpose.
async function reclaimNow(root, { targetBytes, statfs, inventory } = {}) {
  const goal = Math.max(0, Number(targetBytes) || 0);
  const probe = typeof statfs === "function"
    ? (dir) => {
        const info = statfs(dir);
        return Number(info.bavail ?? info.bfree) * Number(info.bsize);
      }
    : freeBytes;
  let free = probe(root);
  if (free >= goal) return { freed: 0, files: 0, free, skipped: "target-met" };
  // The injected inventory (tests) may be sync or async; the default wraps the
  // real async inventory. Both are normalized through Promise.resolve below.
  const listFiles = typeof inventory === "function" ? inventory : async (dir) => (await Promise.resolve(storage.inventory(dir))).files;
  const records = manager.getRecordings({ includeDeleted: true, includeMerged: true });
  const queueFiles = new Set(manager.getQueue()
    .filter((q) => ["queued", "waiting_credentials", "uploading", "paused_recording"].includes(q.status))
    .map((q) => path.resolve(q.file || "")));
  // Smallest first: a handful of caches buys the most time for the least risk.
  const isMainFile = mainFileGuard(records);
  const candidates = (await Promise.resolve(listFiles(root)))
    .filter((file) => file.kind !== "main")
    .filter((file) => !file.locked)
    .filter((file) => !queueFiles.has(path.resolve(file.filePath)))
    // `kind` is a classification, not a guarantee: refuse by ownership too.
    .filter((file) => !isMainFile(file.filePath))
    .sort((a, b) => a.size - b.size);
  let bytes = 0, files = 0;
  for (const file of candidates) {
    if (free >= goal) break;
    try {
      const size = fs.statSync(file.filePath).size;
      if (backupLeases.lockedPath(file.filePath)) continue;
      fs.unlinkSync(file.filePath);
      dropReference(path.resolve(file.filePath), records);
      free += size; bytes += size; files++;
    } catch { /* a file that vanished or is unreadable is simply skipped */ }
  }
  if (files) console.log(`[retention] on-demand reclaim removed ${files} fragment/cache files (${bytes} bytes, free ${free})`);
  return { freed: bytes, files, free };
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await sweep();
    const root = fs.realpathSync(require("../pocket48/recorder")._internals.recordingsDir());
    await purge(root);
  } catch (e) { console.error("[retention]", e.message); } finally { running = false; }
}
function start() { if (!timer) { timer = setInterval(() => { void tick(); }, 600000); timer.unref(); } }
function stop() { clearInterval(timer); timer = null; }
module.exports = { sweep, purge, reclaimNow, start, stop, _internals: { config, freeBytes, DEFAULT_RESERVE_GIB, DEFAULT_TARGET_GIB } };
