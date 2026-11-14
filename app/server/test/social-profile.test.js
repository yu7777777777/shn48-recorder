"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-profile-"));
process.env.DATA_DIR = path.join(root, "data");
// Synthetic test-only configuration: never load local credentials or cookies.
process.env.ADMIN_CREDENTIALS_PATH = path.join(root, "absent-test-credentials.json");
process.env.ADMIN_USERNAME = "lookup-test-admin";
process.env.ADMIN_PASSWORD = "Synthetic-test-password-123";
process.env.SESSION_SECRET = "Synthetic-session-secret-for-lookup-tests";
const { createProfileLookup, LIMITS } = require("../modules/social/profile-lookup");
const accounts = require("../modules/social/accounts");

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const weibo = (id, name = "公开微博昵称") => ({ ok: 1, data: { userInfo: { id, screen_name: name } } });
const bili = (id, name = "公开B站昵称") => ({ code: 0, data: { card: { mid: String(id), name } } });
const make = (fetch, limits, now) => createProfileLookup({ fetch, limits, now });

// Names in fixtures are invented. The tests assert evidence handling, not the
// real-world nickname of 5460950220; only a live official response proves that.
test("Weibo known homepage reuses parser, checks UID and returns the lookup contract", async () => {
  const calls = [];
  const lookup = make(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(weibo("5460950220"));
  });
  assert.equal(accounts.normalizeAccountId("m.weibo.cn/profile/5460950220?tracking=discard", "weibo"), "5460950220");
  const result = await lookup({ platform: "weibo", accountId: "https://weibo.com/u/5460950220?token=discard#discard", cookie: "never-forward", url: "http://localhost/" });
  assert.deepEqual(result, {
    accountId: "5460950220", accountName: "公开微博昵称", profileUrl: "https://weibo.com/5460950220", recognized: true,
    message: "已从官方公开接口识别昵称，请确认后自行保存",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://m.weibo.cn/api/container/getIndex?type=uid&value=5460950220");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(calls).includes("discard"));
  assert.ok(!JSON.stringify(calls).includes("never-forward"));
});

test("Weibo falls back only to the second fixed official public endpoint", async () => {
  const urls = [];
  const lookup = make(async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(null, { status: 432 }) : jsonResponse({ ok: 1, data: { user: { id: 5460950220, screen_name: "公开网页昵称" } } });
  });
  assert.equal((await lookup({ platform: "weibo", accountId: 5460950220 })).accountName, "公开网页昵称");
  assert.deepEqual(urls, ["https://m.weibo.cn/api/container/getIndex?type=uid&value=5460950220", "https://weibo.com/ajax/profile/info?uid=5460950220"]);
});

test("Bilibili accepts a known profile URL and exact official card identity", async () => {
  const lookup = make(async url => {
    assert.equal(url, "https://api.bilibili.com/x/web-interface/card?mid=2");
    return jsonResponse(bili(2, "测试昵称"));
  });
  const result = await lookup({ platform: "bilibili", accountId: "https://space.bilibili.com/2?spm_id_from=discard" });
  assert.equal(result.recognized, true);
  assert.equal(result.accountName, "测试昵称");
  assert.equal(result.profileUrl, "https://space.bilibili.com/2");
});

test("missing users, mismatched IDs, failure envelopes and untrusted nickname fields never produce recognition", async () => {
  for (const [platform, fixture] of [
    ["weibo", { ok: 0, data: weibo("123").data }],
    ["weibo", weibo("999")],
    ["weibo", { ok: 1, data: { userInfo: { screen_name: "无UID不能采信" } } }],
    ["weibo", weibo("123", "<script>alert(1)</script>")],
    ["weibo", weibo("123", "换行\n昵称")],
    ["weibo", weibo("123", "长".repeat(81))],
    ["weibo", weibo("123", 123)],
    ["weibo", weibo("123", "  ")],
    ["bilibili", { code: -404, data: bili(123).data }],
    ["bilibili", bili("999")],
    ["bilibili", { code: 0, data: { card: { name: "无UID不能采信" } } }],
    ["bilibili", { code: 0, data: null }],
  ]) {
    const result = await make(async () => jsonResponse(fixture))({ platform, accountId: "123" });
    assert.equal(result.recognized, false, JSON.stringify(fixture));
    assert.equal(result.accountName, "");
    assert.match(result.message, /手动填写/);
  }
});

test("restricted platforms and manual Weibo handles degrade locally without any network", async () => {
  let calls = 0;
  const lookup = make(async () => { calls++; throw new Error("must not fetch"); });
  for (const [platform, accountId] of [["xiaohongshu", "https://www.xiaohongshu.com/user/profile/5f8a0c9e1b2c3d4e5f6a7b8c?xsec_token=discard"], ["douyin", "https://www.douyin.com/user/MS4wLjABAAAAxxx"], ["weibo", "manual_handle"]]) {
    const result = await lookup({ platform, accountId });
    assert.equal(result.recognized, false);
    assert.equal(result.accountName, "");
    assert.match(result.message, /手动填写/);
    assert.ok(!JSON.stringify(result).includes("discard"));
  }
  assert.equal(calls, 0);
});

test("invalid inputs and SSRF-shaped targets fail before the injected transport", async () => {
  let calls = 0;
  const lookup = make(async () => { calls++; return jsonResponse({}); });
  const cases = [null, [], {}, { platform: "group", accountId: "123" }, { platform: "unknown", accountId: "123" },
    { platform: "bilibili", accountId: "not_a_uid" }, { platform: "weibo", accountId: {} }, { platform: "weibo", accountId: true },
    { platform: "weibo", accountId: Number.MAX_SAFE_INTEGER + 1 }];
  for (const accountId of ["", " ", "0", "0".repeat(20), "1".repeat(21), "a".repeat(161), "uid\n123", "https://127.0.0.1/u/123", "http://169.254.169.254/latest/meta-data", "https://[::1]/123", "https://evil.invalid/u/123", "https://weibo.com.evil.invalid/u/123", "https://weibo.com@evil.invalid/u/123", "https://user:secret@weibo.com/u/123", "https://weibo.com:443/u/123", "https://weibo.com./u/123", "https://weibo.com/x/../u/123", "https://weibo.com/u/%31%32%33", "https://t.cn/abc", "file:///etc/passwd", "javascript:alert(1)", "https://space.bilibili.com/123"]) cases.push({ platform: "weibo", accountId });
  for (const input of cases) await assert.rejects(lookup(input), { statusCode: 400 }, JSON.stringify(input));
  assert.equal(calls, 0);
});

test("redirects, non-JSON, failures and network exceptions are safe, uncached and never followed", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private-secret" } }),
    () => new Response("<title>假昵称</title>", { headers: { "content-type": "text/html" } }),
    () => jsonResponse({ message: "PRIVATE_UPSTREAM_DATA" }, 403),
    () => jsonResponse({ message: "PRIVATE_UPSTREAM_DATA" }, 429),
    () => new Response("invalid JSON PRIVATE_UPSTREAM_DATA", { headers: { "content-type": "application/json" } }),
    () => { throw new Error("PRIVATE_UPSTREAM_DATA cookie=secret"); },
  ]) {
    let calls = 0;
    const lookup = make(async (url, opts) => {
      calls++;
      assert.equal(url, "https://api.bilibili.com/x/web-interface/card?mid=123");
      assert.equal(opts.redirect, "manual");
      return response();
    });
    for (let i = 0; i < 2; i++) {
      const result = await lookup({ platform: "bilibili", accountId: "123" });
      assert.equal(result.recognized, false);
      assert.equal(result.accountName, "");
      assert.ok(!JSON.stringify(result).includes("PRIVATE"));
      assert.ok(!JSON.stringify(result).includes("secret"));
    }
    assert.equal(calls, 2);
  }
});

test("declared and streamed response-size limits cancel bodies", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const lookup = make(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(bili(123, "超长响应".repeat(20))))); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json", ...(declared ? { "content-length": "99999" } : {}) } }), { maxBytes: 64 });
    const result = await lookup({ platform: "bilibili", accountId: "123" });
    assert.equal(result.recognized, false);
    assert.equal(cancelled, true);
  }
});

test("wall-clock deadline includes both fetch and body, aborts transport, and releases slots", async () => {
  for (const stalledBody of [false, true]) {
    let signal;
    let cancelled = 0;
    const lookup = make(async (_url, opts) => {
      signal = opts.signal;
      if (!stalledBody) return new Promise(() => {});
      return new Response(new ReadableStream({ start() {}, cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } });
    }, { timeoutMs: 15, maxConcurrent: 1 });
    const result = await lookup({ platform: "bilibili", accountId: "123" });
    assert.equal(result.recognized, false);
    assert.match(result.message, /超时/);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, stalledBody ? 1 : 0);
    // A deadline returns safely even if the injected network ignores abort.
    assert.match((await lookup({ platform: "bilibili", accountId: "456" })).message, /超时/);
  }
});

test("Weibo deadline prevents fallback, ignores late evidence and does not cache a timed-out lookup", async () => {
  let finish;
  const urls = [];
  const lookup = make(async url => {
    urls.push(url);
    if (urls.length === 1) return new Promise(resolve => { finish = resolve; });
    return jsonResponse(weibo("5460950220", "重试后的公开昵称"));
  }, { timeoutMs: 15 });
  const input = { platform: "weibo", accountId: "5460950220" };
  const result = await lookup(input);
  assert.equal(result.recognized, false);
  assert.match(result.message, /超时/);
  assert.equal(urls.length, 1);
  finish(jsonResponse(weibo("5460950220", "不能采信超时结果")));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls.length, 1, "late completion cannot start another request");
  const retry = await lookup(input);
  assert.equal(retry.recognized, true);
  assert.equal(retry.accountName, "重试后的公开昵称");
  assert.equal(urls.length, 2, "timeout must not populate the success cache");
  assert.ok(urls.every(url => url === "https://m.weibo.cn/api/container/getIndex?type=uid&value=5460950220"));
});

test("failed lookups consume the same finite request budget", async () => {
  let calls = 0;
  const lookup = make(async () => { calls++; throw new Error("private network details"); }, { perMinute: 1 });
  assert.equal((await lookup({ platform: "bilibili", accountId: "1" })).recognized, false);
  assert.match((await lookup({ platform: "bilibili", accountId: "2" })).message, /较频繁/);
  assert.equal(calls, 1);
});

test("successful cache expires, has a finite capacity and cannot be mutated by a caller", async () => {
  let clock = 100;
  let calls = 0;
  const lookup = make(async url => { calls++; return jsonResponse(bili(new URL(url).searchParams.get("mid"))); }, { maxCache: 2, cacheTtlMs: 100 }, () => clock);
  const run = id => lookup({ platform: "bilibili", accountId: id });
  const first = await run("1");
  first.accountName = "tampered";
  assert.equal((await run("1")).accountName, "公开B站昵称");
  assert.equal(calls, 1);
  await run("2"); await run("3"); await run("1");
  assert.equal(calls, 4, "oldest cache entry is evicted");
  clock += 101;
  await run("1");
  assert.equal(calls, 5, "expired cache entry is fetched again");
  assert.ok(LIMITS.maxCache > 0 && LIMITS.maxCache <= 100);
});

test("concurrent duplicate lookups coalesce, independent lookups are bounded and calls are throttled", async () => {
  let release;
  let calls = 0;
  let clock = 100;
  const lookup = make(async url => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return jsonResponse(bili(new URL(url).searchParams.get("mid")));
  }, { maxConcurrent: 1, perMinute: 2 }, () => clock);
  const first = lookup({ platform: "bilibili", accountId: "1" });
  const duplicate = lookup({ platform: "bilibili", accountId: "1" });
  const busy = await lookup({ platform: "bilibili", accountId: "2" });
  assert.equal(busy.recognized, false);
  assert.match(busy.message, /繁忙/);
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, duplicate]);
  assert.equal(results[0].recognized, true);
  assert.deepEqual(results[0], results[1]);
  assert.notEqual(results[0], results[1]);
  assert.equal((await lookup({ platform: "bilibili", accountId: "2" })).recognized, true);
  assert.match((await lookup({ platform: "bilibili", accountId: "3" })).message, /较频繁/);
  assert.equal(calls, 2);
  clock += 60000;
  assert.equal((await lookup({ platform: "bilibili", accountId: "3" })).recognized, true);
  assert.equal(calls, 3);
});

test("lookup route enforces real admin middleware, contract, origin guard and never accesses storage", async () => {
  const express = require("express");
  const auth = require("../lib/admin-auth");
  const { createRouter } = require("../routes/social");
  let calls = 0;
  const lookup = make(async url => {
    calls++;
    const id = new URL(url).searchParams.get("mid");
    if (id === "3") throw new Error("PRIVATE_UPSTREAM_FAILURE");
    if (id === "4") return new Promise(() => {});
    return jsonResponse(bili(2));
  }, { timeoutMs: 20 });
  const app = express();
  app.use(express.json());
  app.use("/api/admin", auth.requireAdmin);
  app.use("/api/admin/social", createRouter({ lookup }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  auth.createSession({ secure: false }, { setHeader(_key, value) { cookie = value.split(";")[0]; } });
  const oldRepository = accounts.repository;
  accounts.repository = () => { throw new Error("lookup must never read/write social records"); };
  const request = (body, headers = {}) => fetch(`${base}/api/admin/social/lookup`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    let res = await request({ platform: "bilibili", accountId: "2" });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).success, false);
    assert.equal(calls, 0);
    res = await request({ platform: "bilibili", accountId: "2" }, { Cookie: "shn48_admin=forged.signature" });
    assert.equal(res.status, 401);
    assert.equal(calls, 0);
    res = await request({ platform: "bilibili", accountId: "2" }, { Cookie: cookie, Origin: "https://evil.invalid" });
    assert.equal(res.status, 403);
    assert.equal(calls, 0);
    res = await request({ platform: "bilibili", accountId: "https://space.bilibili.com/2?token=discard", accountName: "do-not-persist", note: "保留备注" }, { Cookie: cookie, Origin: base });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { success: true, data: { accountId: "2", accountName: "公开B站昵称", profileUrl: "https://space.bilibili.com/2", recognized: true, message: "已从官方公开接口识别昵称，请确认后自行保存" } });
    res = await request({ platform: "bilibili", accountId: "https://127.0.0.1/private-secret" }, { Cookie: cookie });
    assert.equal(res.status, 400);
    const failure = await res.json();
    assert.equal(failure.success, false);
    assert.ok(!JSON.stringify(failure).includes("private-secret"));
    res = await request({ platform: "douyin", accountId: "MS4wLjABAAAAxxx" }, { Cookie: cookie });
    assert.equal(res.status, 200);
    const degraded = await res.json();
    assert.equal(degraded.success, true);
    assert.equal(degraded.data.recognized, false);
    assert.equal(degraded.data.accountName, "");
    assert.match(degraded.data.message, /限制/);
    assert.equal(calls, 1);
    for (const id of ["3", "4"]) {
      res = await request({ platform: "bilibili", accountId: id }, { Cookie: cookie });
      assert.equal(res.status, 200, "upstream failures are safe lookup outcomes, not HTTP errors");
      const unavailable = await res.json();
      assert.equal(unavailable.success, true);
      assert.equal(unavailable.data.recognized, false);
      assert.equal(unavailable.data.accountName, "");
      assert.match(unavailable.data.message, id === "4" ? /超时/ : /手动填写/);
      assert.ok(!JSON.stringify(unavailable).includes("PRIVATE"));
    }
    assert.equal(calls, 3);
  } finally {
    accounts.repository = oldRepository;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
