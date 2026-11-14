"use strict";

// Per-member social accounts (Weibo / Xiaohongshu / Douyin / Bilibili / fan groups).
//
// social_accounts.json stores account rows (server-generated ids) and per-member
// import flags together. Only explicitly selected fields are persisted; free-text
// notes are not inspected for secrets, so callers must not enter credentials.
const fs = require("fs");
const crypto = require("crypto");
const store = require("../../lib/store");

const ACCOUNTS_KEY = "social_accounts";

const PLATFORMS = [
  { key: "weibo", name: "微博", url: "https://weibo.com/{id}", host: "weibo.com" },
  { key: "xiaohongshu", name: "小红书", url: "https://www.xiaohongshu.com/user/profile/{id}", host: "xiaohongshu.com" },
  { key: "douyin", name: "抖音", url: "https://www.douyin.com/user/{id}", host: "douyin.com" },
  { key: "bilibili", name: "B站", url: "https://space.bilibili.com/{id}", host: "space.bilibili.com" },
  { key: "group", name: "应援群", url: "", host: "" },
];
const PLATFORM_KEYS = PLATFORMS.map(item => item.key);
const PLATFORM_MAP = new Map(PLATFORMS.map(item => [item.key, item]));

// Only Weibo has a main/secondary label; manual entry may keep multiple rows.
const SIZE_KEYS = { main: "大号", second: "小号", "": "未区分" };
const GROUP_KINDS = [
  { key: "weibo_group", name: "微博群", platform: "weibo" },
  { key: "qq", name: "QQ群", platform: "" },
  { key: "wechat", name: "微信群", platform: "" },
  { key: "fanqie", name: "番茄/应援会", platform: "" },
  { key: "other", name: "其他", platform: "" },
];
const GROUP_KIND_KEYS = GROUP_KINDS.map(item => item.key);
const MAX_PER_GROUP = 300;
const MAX_ACCOUNT_ID = 160;

function text(value, max) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

// Join/verification notes are the one free-text field. They may span a couple of
// lines, but never carry control characters or unbounded input.
function note(value, max = 300) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
    .trim()
    .slice(0, max);
}

// Row ids are generated on the server and validated on update/delete.
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{9,64}$/.test(value);
}

function newId() {
  return crypto.randomBytes(9).toString("base64url");
}

function normalizeGroupKind(value) {
  const kind = text(value, 160);
  if (GROUP_KIND_KEYS.includes(kind)) return kind;
  // A free-typed label ("微博应援群") is kept as free text under "other".
  const label = (kind.startsWith("other:") ? kind.slice(6) : kind).trim().slice(0, 24);
  return label ? `other:${label}` : "";
}

function groupKindLabel(kind) {
  const preset = GROUP_KINDS.find(item => item.key === kind);
  if (preset) return preset.name;
  return typeof kind === "string" && kind.startsWith("other:") ? kind.slice(6) : "应援群";
}

// Parse only unambiguous profile paths, never resolve redirects or fetch a URL.
// Keep manually entered handles/names compatible; URL-shaped input fails closed.
function normalizeAccountId(value, platform) {
  const raw = String(value ?? "").trim();
  if (!raw) throw badRequest("请填写账号 ID 或群号");
  const looksLikeUrl = /[/:\\?#]/.test(raw) || /^(?:www\.|(?:m\.)?weibo\.|xiaohongshu\.|douyin\.|space\.bilibili\.)/i.test(raw);
  if (!looksLikeUrl) return text(raw, MAX_ACCOUNT_ID);
  const invalid = () => badRequest("无法识别该平台的主页链接，请填写账号 ID；不支持短链接、作品链接或分享文案");
  if (platform === "group" || raw.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(raw)) throw invalid();
  // A missing scheme is accepted for copied domain/path addresses. Explicit
  // schemes must be HTTP(S); credentials, ports and encoded paths are refused.
  const address = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parts = /^https?:\/\/([A-Za-z0-9.-]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(address);
  if (!parts) throw invalid();
  let url;
  try { url = new URL(address); } catch { throw invalid(); }
  const host = url.hostname;
  const pathname = parts[2] || "/";
  let match;
  if (platform === "weibo") {
    if (["weibo.com", "www.weibo.com"].includes(host)) match = /^\/(?:u\/)?(\d{1,20})\/?$/.exec(pathname);
    if (host === "m.weibo.cn") match = /^\/(?:u|profile)\/(\d{1,20})\/?$/.exec(pathname);
  } else if (platform === "xiaohongshu" && ["xiaohongshu.com", "www.xiaohongshu.com"].includes(host)) {
    match = /^\/user\/profile\/([0-9a-f]{20,32})\/?$/i.exec(pathname);
  } else if (platform === "douyin" && ["douyin.com", "www.douyin.com"].includes(host)) {
    match = /^\/user\/([A-Za-z0-9_-]{3,160})\/?$/.exec(pathname);
  } else if (platform === "bilibili" && host === "space.bilibili.com") {
    match = /^\/(\d{1,20})\/?$/.exec(pathname);
  }
  if (!match) throw invalid();
  // Only the path ID survives. Query/fragment tracking and tokens are discarded.
  return match[1];
}

function normalizeAccount(input, { previous } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const platform = String(source.platform || "").trim();
  if (!PLATFORM_MAP.has(platform)) throw badRequest("平台类型无效");
  const base = previous || {};
  const rawAccountId = source.accountId ?? base.accountId;
  const accountId = platform === "group" ? text(rawAccountId, MAX_ACCOUNT_ID) : normalizeAccountId(rawAccountId, platform);
  if (!accountId) throw badRequest("请填写账号 ID 或群号");
  if (platform === "group" && /\/\//.test(accountId)) throw badRequest("应援群请填写群名或群号，不支持主页链接");

  if (platform === "group") {
    const kind = normalizeGroupKind(source.groupKind ?? base.groupKind);
    if (!kind) throw badRequest("请选择应援群类型");
    const rawCount = source.memberCount === undefined ? base.memberCount : source.memberCount;
    const count = rawCount === null || rawCount === undefined || rawCount === "" ? null : Number(rawCount);
    return {
      platform,
      accountId,
      accountName: text(source.accountName ?? base.accountName, 80),
      size: "",
      groupKind: kind,
      memberCount: Number.isInteger(count) && count >= 0 && count <= 5_000_000 ? count : null,
      note: note(source.note ?? base.note),
    };
  }

  // Legacy values remain readable for API compatibility; new rows have no subtype.
  const size = platform === "weibo" ? String(source.size ?? base.size ?? "") : "";
  if (!Object.prototype.hasOwnProperty.call(SIZE_KEYS, size)) throw badRequest("微博账号请选择大号或小号");
  return {
    platform,
    accountId,
    accountName: text(source.accountName ?? base.accountName, 80),
    size,
    groupKind: "",
    memberCount: null,
    // Allow a legacy 300-character note plus its former two-character type label.
    note: note(source.note ?? (base.platform === "weibo" && base.size && !size ? view(base).note : base.note), Math.max(300, String(base.note || "").length + (base.platform === "weibo" && base.size ? 3 : 0))),
  };
}

// The profile links for numeric platforms cannot be derived from a display name,
// so an account is only linked when its id looks like the platform's own id.
function profileUrl(account) {
  const platform = PLATFORM_MAP.get(account.platform);
  if (!platform || !platform.url) return "";
  const id = String(account.accountId || "");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) return "";
  if (account.platform === "bilibili" && !/^\d{1,20}$/.test(id)) return "";
  if (account.platform === "weibo" && !/^[\w-]{3,64}$/.test(id)) return "";
  if (account.platform === "douyin" && !/^[\w-]{3,160}$/.test(id)) return "";
  if (account.platform === "xiaohongshu" && !/^[0-9a-f]{20,32}$/i.test(id)) return "";
  return platform.url.replace("{id}", encodeURIComponent(id));
}

function view(account) {
  const label = account.platform === "weibo" && account.size ? SIZE_KEYS[account.size] : "";
  const originalNote = account.note || "";
  // Preserve old subtype descriptions in the note without rewriting files on GET.
  const displayNote = label && !originalNote.includes(label) ? `${label}\n${originalNote}`.trim() : originalNote;
  return { ...account, note: displayNote, profileUrl: profileUrl(account) };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Missing storage starts empty; malformed/unreadable storage must fail closed so
// a subsequent mutation cannot silently replace existing data with an empty book.
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(store.filePath(ACCOUNTS_KEY), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { items: [], links: {} };
    throw error;
  }
}

function createRepository({ read = loadAccounts, write = (name, data) => store.atomicWrite(store.filePath(name), data), now = () => new Date().toISOString(), id = newId } = {}) {
  function document() {
    const raw = clone(read());
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        !Array.isArray(raw.items) || !raw.links || typeof raw.links !== "object" || Array.isArray(raw.links) ||
        raw.items.some(item => !item || !PLATFORM_MAP.has(item.platform) || !validId(item.id) || typeof item.memberName !== "string")) {
      throw new Error("Invalid social accounts document");
    }
    return { items: raw.items, links: raw.links };
  }

  function persist(items, links) {
    write(ACCOUNTS_KEY, { version: 2, updatedAt: now(), items, links });
  }

  function list() {
    const { items, links } = document();
    return {
      accounts: items.map(view),
      links,
      platforms: PLATFORMS,
      groupKinds: GROUP_KINDS,
      sizes: SIZE_KEYS,
      maxPerGroup: MAX_PER_GROUP,
    };
  }

  function create(input) {
    const memberName = text(input?.memberName, 40);
    if (!memberName) throw badRequest("请选择成员");
    const { items, links } = document();
    const body = normalizeAccount(input);
    const timestamp = now();
    const account = {
      id: id(),
      memberName,
      ...body,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next = [...items, account];
    persist(next, links);
    return { account: view(account), accounts: next.map(view) };
  }

  function update(accountId, input) {
    if (!validId(accountId)) throw badRequest("账号 ID 无效");
    const { items, links } = document();
    const index = items.findIndex(item => item.id === accountId);
    if (index === -1) throw notFound("账号不存在或已被删除");
    const previous = items[index];
    const body = normalizeAccount({ ...input, platform: input?.platform ?? previous.platform }, { previous });
    const memberName = input?.memberName === undefined ? previous.memberName : text(input.memberName, 40);
    if (!memberName) throw badRequest("请选择成员");
    const account = { ...previous, ...body, memberName, updatedAt: now() };
    const next = items.map((item, position) => (position === index ? account : item));
    persist(next, links);
    return { account: view(account), accounts: next.map(view) };
  }

  function remove(accountId) {
    if (!validId(accountId)) throw badRequest("账号 ID 无效");
    const { items, links } = document();
    const next = items.filter(item => item.id !== accountId);
    if (next.length === items.length) throw notFound("账号不存在或已被删除");
    persist(next, links);
    return { accounts: next.map(view) };
  }

  // Directory imports are additive and never rewrite ids. Every skip is
  // reported so the operator can see why a member still has no account.
  function importMembers(input) {
    const rows = Array.isArray(input?.members) ? input.members : [];
    if (!rows.length) throw badRequest("没有可导出的成员");
    if (rows.length > 1000) throw badRequest("单次导入最多 1000 位成员");
    const { items, links } = document();
    const skip = { banned: 0, existing: 0, invalid: 0 };
    const added = [];
    const next = [...items];
    const site = text(input.site, 40);
    const timestamp = now();
    const seen = new Set(items.map(item => `${item.memberName}\u0000${item.platform}\u0000${item.size || ""}`));
    for (const raw of rows) {
      const memberName = text(raw?.memberName, 40);
      if (!memberName) { skip.invalid += 1; continue; }
      if (links[memberName]?.banned) { skip.banned += 1; continue; }
      const platform = String(raw?.platform || "");
      if (!PLATFORM_MAP.has(platform)) { skip.invalid += 1; continue; }
      const size = platform === "weibo" ? String(raw?.size || "main") : "";
      if (!Object.prototype.hasOwnProperty.call(SIZE_KEYS, size)) { skip.invalid += 1; continue; }
      let body;
      try { body = normalizeAccount({ ...raw, size }); }
      catch { skip.invalid += 1; continue; }
      const key = `${memberName}\u0000${platform}\u0000${body.size || ""}`;
      if (seen.has(key)) { skip.existing += 1; continue; }
      seen.add(key);
      const account = { id: id(), memberName, ...body, site, createdAt: timestamp, updatedAt: timestamp };
      next.push(account);
      added.push(account);
    }
    if (added.length) persist(next, links);
    return {
      added: added.length,
      skipped: skip.existing + skip.banned + skip.invalid,
      details: { ...skip },
      accounts: next.map(view),
    };
  }

  function setLink(memberNameRaw, input) {
    const memberName = text(memberNameRaw, 40);
    if (!memberName) throw badRequest("成员名无效");
    const { items, links: current } = document();
    const links = { ...current };
    const banned = input?.banned === true;
    const memberNote = note(input?.note, 200);
    if (!banned && !memberNote) delete links[memberName];
    else Object.defineProperty(links, memberName, { value: { banned, note: memberNote }, enumerable: true, configurable: true, writable: true });
    persist(items, links);
    return { links };
  }

  return { list, create, update, remove, importMembers, setLink, _persist: persist };
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

let singleton = null;
function repository() {
  if (!singleton) singleton = createRepository();
  return singleton;
}

module.exports = {
  PLATFORMS,
  PLATFORM_KEYS,
  GROUP_KINDS,
  SIZE_KEYS,
  repository,
  createRepository,
  normalizeAccount,
  normalizeAccountId,
  profileUrl,
  validId,
  groupKindLabel,
  _internals: { text, note, clone, ACCOUNTS_KEY, MAX_PER_GROUP },
};
