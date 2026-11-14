"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const MAX_SESSIONS = 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const keyOf = id => crypto.createHash("sha256").update(id).digest("hex");

// Only token digests are stored; the file cannot be used as a login cookie.
function createRememberedSessions({ filePath, scope, now = () => Date.now() }) {
  let loadedScope = null;
  let entries = new Map();
  function load() {
    const currentScope = scope();
    if (loadedScope === currentScope) return;
    entries = new Map();
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (record.version === 1 && record.scope === currentScope && Array.isArray(record.sessions)) {
        for (const entry of record.sessions.slice(-MAX_SESSIONS)) {
          if (/^[a-f0-9]{64}$/.test(entry?.key) && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.expiresAt)
              && entry.createdAt <= now() && entry.expiresAt > now() && entry.expiresAt > entry.createdAt
              && entry.expiresAt - entry.createdAt <= MAX_TTL_MS) {
            entries.set(entry.key, { key: entry.key, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("[auth] remembered session store unavailable; saved sessions rejected");
    }
    loadedScope = currentScope;
  }
  function persist(next) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ version: 1, scope: loadedScope, sessions: [...next.values()] }) + "\n");
      fs.fsyncSync(handle);
      fs.closeSync(handle); handle = undefined;
      // The mode at open() is the guarantee on POSIX. Windows reports synthetic 0666
      // for every file and ignores chmod(), so there the ACL is what protects the
      // file; a chmod here would be a no-op that only looks like a safeguard.
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, filePath);
      entries = next;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      fs.rmSync(temporary, { force: true });
    }
  }
  function clean(next) {
    for (const [key, entry] of next) if (entry.expiresAt <= now()) next.delete(key);
    while (next.size > MAX_SESSIONS) next.delete(next.keys().next().value);
    return next;
  }
  return {
    get(id) {
      load();
      const entry = entries.get(keyOf(id));
      if (!entry || entry.expiresAt <= now()) return null;
      return { id, createdAt: entry.createdAt, expiresAt: entry.expiresAt, rememberMe: true };
    },
    add(session) {
      load(); const next = clean(new Map(entries));
      next.set(keyOf(session.id), { key: keyOf(session.id), createdAt: session.createdAt, expiresAt: session.expiresAt });
      persist(clean(next));
    },
    remove(id) {
      load(); const next = new Map(entries);
      if (next.delete(keyOf(id))) persist(clean(next));
    },
    clear() { load(); persist(new Map()); },
    cleanup() {
      load(); const next = clean(new Map(entries));
      if (next.size !== entries.size) persist(next);
    },
  };
}

module.exports = { createRememberedSessions };
