"use strict";

// Social account book: storage shape, Weibo main/secondary split, group rows,
// idempotent directory import, and the "same name, different person" ban.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-accounts-"));
process.env.DATA_DIR = path.join(root, "data");
const accounts = require("../modules/social/accounts");

function repo() {
  const files = new Map();
  return accounts.createRepository({
    read: () => files.get(accounts._internals.ACCOUNTS_KEY) || { items: [], links: {} },
    write: (name, data) => files.set(name, JSON.parse(JSON.stringify(data))),
    id: () => `acc${String(++repo.idx).padStart(8, "0")}`,
    now: () => "2026-10-21T00:00:00.000Z",
  });
}
repo.idx = 0;

test("new Weibo accounts use free-form notes without a default subtype", () => {
  const r = repo();
  const row = r.create({ memberName: "张三", platform: "weibo", accountId: "freeform", note: "小号，偶尔更新日常" }).account;
  assert.equal(row.size, "");
  assert.equal(row.note, "小号，偶尔更新日常");
  assert.equal(r.list().accounts[0].note, row.note);
});

test("legacy subtype is preserved in notes and can be retired by editing without duplication", () => {
  const r = repo();
  const original = "原".repeat(300);
  const row = r.create({ memberName: "张三", platform: "weibo", size: "second", accountId: "legacy", note: original }).account;
  assert.equal(row.note, "小号\n" + original);
  assert.equal(r.list().accounts[0].note, row.note);
  const saved = r.update(row.id, { size: "", note: row.note }).account;
  assert.equal(saved.size, "");
  assert.equal(saved.note, "小号\n" + original);
  assert.equal(r.update(row.id, { size: "", note: saved.note }).account.note, saved.note);
  assert.equal(r.update(row.id, { note: "改为普通日常记录" }).account.note, "改为普通日常记录");
  const main = r.create({ memberName: "李四", platform: "weibo", size: "main", accountId: "oldmain", note: "这是大号" }).account;
  assert.equal(main.note, "这是大号");
});

test("legacy subtype retirement without a note preserves both labels and all 300 characters", () => {
  for (const [size, label] of [["main", "大号"], ["second", "小号"]]) {
    let writes = 0;
    let stored = { items: [{ id: "legacy12345", memberName: "成员", platform: "weibo", accountId: "123456", size, note: "原".repeat(300) }], links: {} };
    const snapshot = JSON.stringify(stored);
    const book = accounts.createRepository({ read: () => stored, write: (_key, value) => { writes += 1; stored = value; } });
    const display = book.list().accounts[0];
    assert.equal(display.note, label + "\n" + "原".repeat(300));
    assert.equal(JSON.stringify(stored), snapshot, "GET must not migrate storage");
    assert.equal(writes, 0);
    const retired = book.update(display.id, { size: "" }).account;
    assert.equal(retired.note, display.note);
    assert.equal(retired.size, "");
    assert.equal(book.update(display.id, { accountName: "编辑昵称" }).account.note, display.note);
    assert.equal(book.update(display.id, { size: "", note: display.note }).account.note, display.note);
    assert.equal(book.update(display.id, { note: "" }).account.note, "", "explicit note edits remain authoritative");
  }
});

test("bare handles, names and group text keep their previous semantics", () => {
  const book = repo();
  for (const [platform, accountId] of [["weibo", "账号名"], ["weibo", "zs_main"], ["xiaohongshu", "小红书号"], ["douyin", "抖音号"], ["bilibili", "000123"]]) {
    assert.equal(book.create({ memberName: "成员", platform, accountId }).account.accountId, accountId);
  }
  assert.equal(book.create({ memberName: "成员", platform: "group", groupKind: "qq", accountId: "应援/交流一群" }).account.accountId, "应援/交流一群");
});

test("a new store lists every platform with Weibo split into main and secondary", () => {
  const data = repo().list();
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(data.platforms.map(item => item.key), ["weibo", "xiaohongshu", "douyin", "bilibili", "group"]);
  assert.deepEqual(data.sizes, { main: "大号", second: "小号", "": "未区分" });
  assert.equal(data.groupKinds[0].key, "weibo_group");
});

test("Weibo keeps a main and a secondary account for the same member", () => {
  const store = repo();
  store.create({ memberName: "张三", platform: "weibo", size: "main", accountId: "zhangsan_main", accountName: "张三" });
  const { accounts: rows } = store.create({ memberName: "张三", platform: "weibo", size: "second", accountId: "zhangsan_2" });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(item => item.size), ["main", "second"]);
  assert.equal(rows[0].profileUrl, "https://weibo.com/zhangsan_main");
});

test("Weibo rejects an unknown size and other platforms ignore it", () => {
  const store = repo();
  assert.throws(() => store.create({ memberName: "张三", platform: "weibo", size: "third", accountId: "x" }), /大号|小号/);
  const { account } = store.create({ memberName: "张三", platform: "douyin", size: "second", accountId: "12345" });
  assert.equal(account.size, "");
  assert.equal(account.profileUrl, "https://www.douyin.com/user/12345");
});

test("a group row records its kind, join count and note, with a free-typed kind kept", () => {
  const store = repo();
  const { account } = store.create({ memberName: "张三", platform: "group", groupKind: "weibo_group", accountId: "应援一群", memberCount: 480, note: "群号\n入群暗号" });
  assert.equal(account.groupKind, "weibo_group");
  assert.equal(account.memberCount, 480);
  assert.equal(account.note, "群号\n入群暗号");
  assert.equal(account.profileUrl, "");
  const custom = store.create({ memberName: "李四", platform: "group", groupKind: "微博应援群", accountId: "二群" }).account;
  assert.equal(custom.groupKind, "other:微博应援群");
  assert.equal(accounts.groupKindLabel(custom.groupKind), "微博应援群");
  assert.throws(() => store.create({ memberName: "李四", platform: "group", groupKind: "", accountId: "三群" }), /类型/);
});

test("profile URLs extract path IDs locally and discard tracking without changing fields", () => {
  const book = repo();
  const secUid = "MS4wLjABAAAA" + "a".repeat(70);
  const cases = [
    ["weibo", " https://weibo.com/u/1234567890?refer_flag=secret#tracked ", "1234567890", "https://weibo.com/1234567890"],
    ["weibo", "http://www.weibo.com/1234567890/", "1234567890", "https://weibo.com/1234567890"],
    ["weibo", "m.weibo.cn/profile/1234567890?uid=999", "1234567890", "https://weibo.com/1234567890"],
    ["weibo", "https://m.weibo.cn/u/1234567890", "1234567890", "https://weibo.com/1234567890"],
    ["xiaohongshu", "https://www.xiaohongshu.com/user/profile/5f8a0c9e1b2c3d4e5f6a7b8c?xsec_token=secret&xsec_source=app#tracked", "5f8a0c9e1b2c3d4e5f6a7b8c", "https://www.xiaohongshu.com/user/profile/5f8a0c9e1b2c3d4e5f6a7b8c"],
    ["xiaohongshu", "xiaohongshu.com/user/profile/5F8A0C9E1B2C3D4E5F6A7B8C/", "5F8A0C9E1B2C3D4E5F6A7B8C", "https://www.xiaohongshu.com/user/profile/5F8A0C9E1B2C3D4E5F6A7B8C"],
    ["douyin", `https://www.douyin.com/user/${secUid}?sec_uid=wrong&from=secret`, secUid, `https://www.douyin.com/user/${secUid}`],
    ["douyin", "douyin.com/user/abc_123-/", "abc_123-", "https://www.douyin.com/user/abc_123-"],
    ["bilibili", "https://space.bilibili.com/12345678/?spm_id_from=secret#tracked", "12345678", "https://space.bilibili.com/12345678"],
  ];
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error("profile normalization must not access the network"); };
  try {
    for (const [platform, accountId, expected, expectedUrl] of cases) {
      const row = book.create({ memberName: "成员", platform, accountId, accountName: "昵称", note: "日常号", url: accountId }).account;
      assert.equal(row.accountId, expected);
      assert.equal(row.profileUrl, expectedUrl);
      assert.equal(row.accountName, "昵称");
      assert.equal(row.note, "日常号");
      assert.equal(row.size, "");
      assert.equal(Object.hasOwn(row, "url"), false);
      assert.ok(!JSON.stringify(row).includes("secret"));
    }
  } finally { global.fetch = originalFetch; }
  assert.throws(() => book.create({ memberName: "成员", platform: "weibo", accountId: "   " }), /账号 ID/);
  assert.throws(() => book.create({ memberName: "", platform: "weibo", accountId: "abc" }), /成员/);
});

test("ambiguous, foreign, malformed and short links fail closed without guessing an ID", () => {
  const book = repo();
  const cases = [
    ["weibo", "https://weibo.com/n/someone"],
    ["weibo", "https://weibo.com/someone"],
    ["weibo", "https://weibo.com/123/456"],
    ["weibo", "https://weibo.com/u/123/status"],
    ["weibo", "https://weibo.com/?uid=123"],
    ["weibo", "https://t.cn/abc"],
    ["xiaohongshu", "https://xhslink.com/abc"],
    ["douyin", "https://v.douyin.com/abc"],
    ["bilibili", "https://b23.tv/abc"],
    ["bilibili", "https://www.bilibili.com/video/BV123?uid=123"],
    ["bilibili", "https://space.bilibili.com/123/video"],
    ["xiaohongshu", "https://www.xiaohongshu.com/explore/5f8a0c9e1b2c3d4e5f6a7b8c"],
    ["xiaohongshu", "https://www.xiaohongshu.com/user/profile/not-a-profile-id"],
    ["douyin", "https://www.douyin.com/video/123?sec_uid=abc"],
    ["weibo", "https://space.bilibili.com/123"],
    ["weibo", "https://weibo.com.evil.invalid/u/123"],
    ["weibo", "https://evil.invalid/u/123?url=https://weibo.com/u/456"],
    ["weibo", "https://127.0.0.1/u/123"],
    ["weibo", "http://169.254.169.254/latest/meta-data"],
    ["weibo", "https://user:password@weibo.com/u/123"],
    ["weibo", "https://weibo.com@evil.invalid/u/123"],
    ["weibo", "https://weibo.com:443/u/123"],
    ["weibo", "https://weibo.com./u/123"],
    ["weibo", "ftp://weibo.com/u/123"],
    ["weibo", "javascript:alert(123)"],
    ["weibo", "//weibo.com/u/123"],
    ["weibo", "https://weibo.com/u/%31%32%33"],
    ["weibo", "https://weibo.com/x/../u/123"],
    ["weibo", "https://weibo.com/x/%2e%2e/u/123"],
    ["weibo", "https://weibo.com//u/123"],
    ["weibo", "https://weibo.com/u/123\n456"],
    ["weibo", "https://weibo.com\\u\\123"],
    ["weibo", "分享主页 https://weibo.com/u/123"],
    ["weibo", "https://weibo.com/u/123 https://weibo.com/u/456"],
    ["weibo", "https://weibo.com/u/123?tracking=" + "a".repeat(4096)],
    ["douyin", "https://www.douyin.com/user/" + "a".repeat(161)],
    ["bilibili", "https://space.bilibili.com/123456789012345678901"],
    ["group", "https://weibo.com/u/123"],
  ];
  for (const [platform, accountId] of cases) {
    assert.throws(() => book.create({ memberName: "成员", platform, accountId, groupKind: "qq" }), error => error.statusCode === 400 && /链接/.test(error.message), `${platform}: ${accountId}`);
  }
  assert.equal(book.list().accounts.length, 0);
});

test("URL normalization works on update and import; invalid updates do not alter stored rows", () => {
  const book = repo();
  const old = book.create({ memberName: "成员", platform: "bilibili", accountId: "123", note: "保留备注" }).account;
  const updated = book.update(old.id, { accountId: "space.bilibili.com/456?tracking=secret" }).account;
  assert.equal(updated.accountId, "456");
  assert.equal(updated.note, old.note);
  assert.equal(updated.id, old.id);
  assert.throws(() => book.update(old.id, { accountId: "https://b23.tv/abc" }), { statusCode: 400 });
  assert.deepEqual(book.list().accounts, [updated]);
  const imported = book.importMembers({ members: [
    { memberName: "有效", platform: "bilibili", accountId: "https://space.bilibili.com/789?tracking=secret" },
    { memberName: "无效", platform: "bilibili", accountId: "https://b23.tv/xyz" },
  ] });
  assert.equal(imported.added, 1);
  assert.equal(imported.details.invalid, 1);
  assert.equal(imported.accounts[1].accountId, "789");
  assert.ok(!JSON.stringify(imported).includes("secret"));
});

test("an account can be edited and removed by id only", () => {
  const store = repo();
  const created = store.create({ memberName: "张三", platform: "xiaohongshu", accountId: "5f8a0c9e1b2c3d4e5f6a7b8c" }).account;
  const updated = store.update(created.id, { memberName: "张小三", accountName: "日常号" }).account;
  assert.equal(updated.memberName, "张小三");
  assert.equal(updated.accountName, "日常号");
  assert.equal(updated.id, created.id);
  assert.equal(updated.profileUrl, "https://www.xiaohongshu.com/user/profile/5f8a0c9e1b2c3d4e5f6a7b8c");
  assert.throws(() => store.update("not-an-id!", {}), /无效/);
  assert.throws(() => store.update("aaaaaaaaaaaaaaaa", {}), /不存在/);
  assert.deepEqual(store.remove(created.id).accounts, []);
  assert.throws(() => store.remove(created.id), /不存在/);
});

test("importing the directory twice adds each account once and honours bans", () => {
  const store = repo();
  const members = [
    { memberName: "张三", platform: "weibo", size: "main", accountId: "zs_main" },
    { memberName: "张三", platform: "weibo", size: "second", accountId: "zs_2" },
    { memberName: "李四", platform: "bilibili", accountId: "123456" },
  ];
  const first = store.importMembers({ site: "SNH48", members });
  assert.equal(first.added, 3);
  const second = store.importMembers({ site: "SNH48", members });
  assert.equal(second.added, 0);
  assert.equal(second.details.existing, 3);
  store.setLink("李四", { banned: true });
  const third = store.importMembers({ members: [{ memberName: "李四", platform: "douyin", accountId: "888" }] });
  assert.equal(third.added, 0);
  assert.equal(third.details.banned, 1);
  assert.equal(store.list().accounts.filter(item => item.memberName === "李四").length, 1);
});

test("a banned member does not swallow accounts they already own", () => {
  const store = repo();
  store.create({ memberName: "李四", platform: "bilibili", accountId: "123" });
  store.setLink("李四", { banned: true });
  const result = store.importMembers({ members: [{ memberName: "李四", platform: "bilibili", accountId: "456" }] });
  assert.equal(result.added, 0);
  assert.equal(result.details.banned, 1);
});

test("unbanning removes the link instead of keeping a dead flag", () => {
  const store = repo();
  assert.deepEqual(store.setLink("李四", { banned: false, note: "" }).links, {});
  store.setLink("李四", { note: "同名不同人，待确认" });
  assert.deepEqual(store.list().links["李四"], { banned: false, note: "同名不同人，待确认" });
});

test("the route is registered behind admin authentication", async () => {
  const { createApp } = require("../index");
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/admin/social`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).success, false);
    const lookupResponse = await fetch(`${origin}/api/admin/social/lookup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "weibo", accountId: "5460950220" }),
    });
    assert.equal(lookupResponse.status, 401, "lookup must remain behind the production admin gate");
    assert.equal((await lookupResponse.json()).success, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("custom group labels stay canonical across create, no-op edits and import", () => {
  const book = repo();
  const created = book.create({ memberName: "成员", platform: "group", groupKind: "other:自定义群", accountId: "123" }).account;
  assert.equal(created.groupKind, "other:自定义群");
  for (let i = 0; i < 3; i++) {
    assert.equal(book.update(created.id, { note: "编辑" }).account.groupKind, "other:自定义群");
  }
  assert.equal(book.update(created.id, { groupKind: "other:自定义群" }).account.groupKind, "other:自定义群");
  const imported = book.importMembers({ members: [{ memberName: "另一位", platform: "group", groupKind: "other:测试群", accountId: "456" }] });
  assert.equal(imported.accounts[1].groupKind, "other:测试群");
  assert.throws(() => book.create({ memberName: "成员", platform: "group", groupKind: "other:   ", accountId: "123" }), /类型/);
});

test("group count remains unset unless provided and can be explicitly cleared", () => {
  const book = repo();
  const account = book.create({ memberName: "成员", platform: "group", groupKind: "qq", accountId: "123", memberCount: 48 }).account;
  assert.equal(book.update(account.id, { memberCount: null }).account.memberCount, null);
  assert.equal(book.update(account.id, { note: "备注" }).account.memberCount, null);
  assert.equal(book.create({ memberName: "成员", platform: "group", groupKind: "qq", accountId: "456" }).account.memberCount, null);
});

test("file persistence survives a new repository and removes flags without resurrection", () => {
  const book = accounts.createRepository();
  const created = book.create({ memberName: "持久成员", platform: "weibo", accountId: "12345" }).account;
  book.setLink("持久成员", { banned: true });
  const reopened = accounts.createRepository();
  assert.equal(reopened.list().accounts[0].id, created.id);
  assert.equal(reopened.list().links["持久成员"].banned, true);
  reopened.setLink("持久成员", { banned: false });
  assert.deepEqual(accounts.createRepository().list().links, {});
  const location = require("../lib/store").filePath(accounts._internals.ACCOUNTS_KEY);
  const original = fs.readFileSync(location, "utf8");
  for (const broken of ["{broken", JSON.stringify({ items: "not-array", links: {} }), JSON.stringify({ items: [], links: [] })]) {
    fs.writeFileSync(location, broken);
    assert.throws(() => accounts.createRepository().create({ memberName: "新成员", platform: "weibo", accountId: "999" }));
    assert.equal(fs.readFileSync(location, "utf8"), broken, "bad storage must not be overwritten");
  }
  fs.writeFileSync(location, original);
});

test("write failure cannot mutate an injected read snapshot", () => {
  const raw = { items: [], links: {} };
  const book = accounts.createRepository({ read: () => raw, write: () => { throw new Error("disk unavailable"); } });
  assert.throws(() => book.setLink("成员", { banned: true }), /disk/);
  assert.deepEqual(raw, { items: [], links: {} });
  assert.throws(() => book.create({ memberName: "成员", platform: "weibo", accountId: "12345" }), /disk/);
  assert.deepEqual(raw.items, []);
});

test("special member names are stored as own keys without prototype mutation", () => {
  const book = repo();
  book.setLink("__proto__", { banned: true });
  assert.equal(Object.hasOwn(book.list().links, "__proto__"), true);
  assert.equal(book.list().links.__proto__.banned, true);
  book.setLink("__proto__", { banned: false });
  assert.equal(Object.hasOwn(book.list().links, "__proto__"), false);
});

test("route parameters decode once; unexpected read/write errors stay private", async () => {
  const express = require("express");
  const original = accounts.repository;
  const book = repo();
  accounts.repository = () => book;
  const app = express();
  app.use(express.json());
  app.use("/social", require("../routes/social"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (url, method, body, extra = {}) => fetch(base + url, { method, headers: { "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    for (const name of ["成员%", "成员%2F", "成员%25", "成员/名字"]) {
      const res = await request("/social/members/" + encodeURIComponent(name), "PUT", { banned: true });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).data.links[name].banned, true);
    }
    const created = await request("/social/accounts", "POST", { memberName: "成员", platform: "weibo", accountId: "https://weibo.com/u/123456?tracking=secret", note: "日常号" });
    assert.equal(created.status, 200);
    assert.equal(created.headers.get("cache-control"), "no-store");
    const account = (await created.json()).data.account;
    assert.equal(account.accountId, "123456");
    assert.equal(account.profileUrl, "https://weibo.com/123456");
    const edited = await request(`/social/accounts/${account.id}`, "PUT", { accountId: "https://weibo.com/u/789012#secret" });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).data.account.accountId, "789012");
    const invalid = await request(`/social/accounts/${account.id}`, "PUT", { accountId: "https://t.cn/secret" });
    assert.equal(invalid.status, 400);
    const failure = await invalid.json();
    assert.equal(failure.success, false);
    assert.match(failure.error, /无法识别.*主页链接/);
    assert.ok(!failure.error.includes("secret"));
    assert.equal(book.list().accounts[0].accountId, "789012");
    assert.equal((await request("/social/accounts", "POST", { memberName: "", platform: "weibo", accountId: "123" })).status, 400);
    assert.equal((await request("/social/accounts/aaaaaaaaaaaa", "DELETE")).status, 404);
    assert.equal((await request("/social/members/test", "PUT", { banned: true }, { Origin: "https://evil.invalid" })).status, 403);
    accounts.repository = () => accounts.createRepository({ read: () => { throw new Error("PRIVATE_PATH_AND_DATA"); } });
    let res = await request("/social", "GET");
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes("PRIVATE_PATH_AND_DATA"));
    accounts.repository = () => accounts.createRepository({ read: () => ({ items: [], links: {} }), write: () => { throw new Error("PRIVATE_WRITE_PATH"); } });
    res = await request("/social/accounts", "POST", { memberName: "成员", platform: "weibo", accountId: "123" });
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes("PRIVATE_WRITE_PATH"));
  } finally {
    accounts.repository = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
