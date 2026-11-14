"use strict";
// Time-limited, revocable access codes for sharing one member's social directory.
// Storage holds only a SHA-256 of each code, so a leaked data file cannot be replayed.
const crypto = require("crypto");
const store = require("../../lib/store");
const KEY = "social_access_codes";
const MAX_CODES = 20;
const MAX_LIFETIME_MS = 30 * 24 * 3600 * 1000;
function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function load() { const value = store.load(KEY, { codes: [] }); return Array.isArray(value?.codes) ? value.codes.filter(item => item && typeof item === "object").slice(0, MAX_CODES) : []; }
function save(codes) { store.atomicWrite(store.filePath(KEY), { codes: codes.slice(0, MAX_CODES) }); }
function digest(code) { return crypto.createHash("sha256").update(String(code)).digest("hex"); }
function now(clock) { return Number(clock && typeof clock.now === "function" ? clock.now() : Date.now()); }
// The plaintext code is returned exactly once, at creation.
function create(memberName, options = {}, clock) {
  const name = String(memberName || "").trim();
  if (!name || name.length > 60) throw fail("请选择要分享的成员");
  const createdAt = now(clock);
  const hours = Number(options.hours ?? 72);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) throw fail("有效期须为 1 到 720 小时");
  const expiresAt = createdAt + Math.round(hours * 3600 * 1000);
  if (expiresAt - createdAt > MAX_LIFETIME_MS) throw fail("有效期不能超过 30 天");
  const live = load().filter(item => item.memberName !== name);
  if (live.length >= MAX_CODES) throw fail("访问码数量已达上限，请先撤销不用的访问码", 409);
  const code = crypto.randomBytes(24).toString("base64url");
  const record = { id: crypto.randomUUID(), memberName: name, hash: digest(code), createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  save([record, ...live]);
  return { code, expiresAt: record.expiresAt, memberName: name };
}
function list(clock) {
  const at = now(clock);
  return load().map(({ hash, ...rest }) => ({ ...rest, uses: Number(rest.uses) || 0, lastUsedAt: rest.lastUsedAt || null, expired: Date.parse(rest.expiresAt) <= at }));
}
function revoke(id) {
  const codes = load(), next = codes.filter(item => item.id !== id);
  if (next.length === codes.length) throw fail("访问码不存在", 404);
  save(next); return { revoked: true };
}
// Resolves a presented code to the member it exposes, or null. Expired codes are
// rejected but kept until revoked so the list still explains why a link stopped.
// Resolving records a use so an administrator can see whether a link is still
// needed. The write is best-effort: a failed audit must never break access.
function resolve(code, clock) {
  const text = String(code || "").trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(text)) return null;
  const at = now(clock), hash = digest(text);
  const codes = load();
  const record = codes.find(item => item.hash === hash && Date.parse(item.expiresAt) > at);
  if (!record) return null;
  try {
    record.lastUsedAt = new Date(at).toISOString();
    record.uses = (Number(record.uses) || 0) + 1;
    save(codes);
  } catch { /* auditing is optional */ }
  return { memberName: record.memberName };
}
// The guest shape: accounts of one member, without notes (free text the admin
// never agreed to publish), stamps, or any other member's data.
function publicAccounts(accounts, memberName) {
  const rows = (Array.isArray(accounts) ? accounts : []).filter(item => item && item.memberName === memberName);
  return rows.map(item => ({ platform: item.platform, accountId: item.accountId, accountName: item.accountName || "", groupKind: item.groupKind || "", profileUrl: item.profileUrl || "" }));
}
module.exports = { create, list, revoke, resolve, publicAccounts, KEY, MAX_CODES, MAX_LIFETIME_MS };
