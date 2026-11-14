"use strict";

// Leaf module: never import the queue, recorder, or backup service here.
const fs = require("fs");
const path = require("path");
const paths = new Map();
const owners = new Map();

function normalize(file) {
  if (typeof file !== "string" || !file) return null;
  let full = path.resolve(file);
  try { full = fs.realpathSync(full); } catch { /* Missing attachments still need a stable key. */ }
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function acquire(owner, files) {
  const keys = [...new Set((files || []).map(normalize).filter(Boolean))];
  const lease = { owner, keys, released: false };
  if (!owners.has(owner)) owners.set(owner, new Set());
  owners.get(owner).add(lease);
  for (const key of keys) {
    if (!paths.has(key)) paths.set(key, new Set());
    paths.get(key).add(lease);
  }
  return () => release(lease);
}

function release(lease) {
  if (lease.released) return;
  lease.released = true;
  for (const key of lease.keys) {
    const held = paths.get(key);
    held?.delete(lease);
    if (!held?.size) paths.delete(key);
  }
  const held = owners.get(lease.owner);
  held?.delete(lease);
  if (!held?.size) owners.delete(lease.owner);
}

function lockedPath(file) { return paths.has(normalize(file)); }
function lockedRecording(rec) {
  return Boolean(rec && [rec.filePath, ...(rec.sourceFiles || []), rec.replayRecovery?.replayFilePath].some(lockedPath));
}
function releaseOwner(owner) {
  for (const lease of [...(owners.get(owner) || [])]) release(lease);
}
function _reset() {
  for (const owner of [...owners.keys()]) releaseOwner(owner);
}

module.exports = { acquire, lockedPath, lockedRecording, releaseOwner, _reset };
