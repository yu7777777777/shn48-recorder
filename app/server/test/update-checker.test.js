"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-update-checker-"));
process.env.DATA_DIR = path.join(root, "data");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const updateChecker = require("../modules/update-checker");
const notify = require("../modules/notify");
const store = require("../lib/store");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// Both the checker (GitHub) and the notify dispatcher (webhook) go through
// global fetch: route by URL prefix.
function mockFetch(github) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.startsWith("https://api.github.com/")) return github(target, init);
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("save validates repo, branch, interval and masks the token", () => {
  assert.throws(() => updateChecker.save({ repo: "no-slash" }), /owner\/name/);
  assert.throws(() => updateChecker.save({ repo: "a/b/c" }), /owner\/name/);
  assert.throws(() => updateChecker.save({ branch: "bad branch" }), /分支名/);
  assert.throws(() => updateChecker.save({ intervalHours: 0 }), /1-168/);
  assert.throws(() => updateChecker.save({ intervalHours: 200 }), /1-168/);
  assert.throws(() => updateChecker.save({ token: "has space" }), /Token 格式/);

  const saved = updateChecker.save({
    enabled: true, repo: " owner/repo ", branch: " main ", intervalHours: 12, token: "github_pat_test1234567890",
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.repo, "owner/repo");
  assert.equal(saved.branch, "main");
  assert.equal(saved.intervalHours, 12);
  assert.equal(saved.token, undefined, "token never leaves the server");
  assert.equal(saved.tokenSet, true);
  // Re-saving without the token must not erase the stored one.
  updateChecker.save({ intervalHours: 24 });
  assert.equal(updateChecker.publicSettings().tokenSet, true);
  assert.equal(updateChecker.publicSettings().intervalHours, 24);
  // Clearing works through the explicit clear list.
  updateChecker.save({ clear: ["token"] });
  assert.equal(updateChecker.publicSettings().tokenSet, false);
  updateChecker.save({ token: "github_pat_test1234567890" });
});

test("greater() compares release versions numerically", () => {
  assert.equal(updateChecker.greater("1.33.0", "1.32.4"), true);
  assert.equal(updateChecker.greater("1.32.10", "1.32.9"), true);
  assert.equal(updateChecker.greater("1.32.4", "1.32.4"), false);
  assert.equal(updateChecker.greater("1.32.3", "1.32.4"), false);
  assert.equal(updateChecker.greater("2.0", "1.99.9"), true);
});

test("checkNow notifies once per released version and records state", async () => {
  notify.save({
    enabled: true,
    channels: {
      telegram: { enabled: false }, email: { enabled: false }, serverchan: { enabled: false }, bark: { enabled: false },
      webhook: { enabled: true, url: "https://hooks.example.com/hook", secret: "k1" },
    },
    events: { update_available: true },
  });
  updateChecker.save({ repo: "owner/repo", branch: "main", token: "github_pat_test1234567890" });

  const { calls, restore } = mockFetch(async target => {
    assert.ok(target.includes("/contents/app/VERSION"), "reads the repo VERSION file");
    assert.ok(target.includes("ref=main"), "pins the configured branch");
    return { ok: true, status: 200, text: async () => "1.34.0\n" };
  });
  try {
    const first = await updateChecker.checkNow();
    assert.equal(first.upToDate, false);
    assert.equal(first.remoteVersion, "1.34.0");
    assert.equal(first.notified, true);
    // Delivery is asynchronous: let the notify dispatcher settle.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const hookCalls = calls.filter(call => call.url.startsWith("https://hooks.example.com/"));
    assert.equal(hookCalls.length, 1, "one webhook delivery");
    assert.equal(JSON.parse(hookCalls[0].init.body).event, "update_available");
    assert.ok(JSON.parse(hookCalls[0].init.body).text.includes("1.34.0"));
    const state = updateChecker.state();
    assert.equal(state.lastNotifiedVersion, "1.34.0");
    assert.equal(state.upToDate, false);
    assert.ok(state.lastCheckAt);

    // Same version again: no duplicate notification.
    await updateChecker.checkNow();
    assert.equal(calls.filter(call => call.url.startsWith("https://hooks.example.com/")).length, 1);

    // A newer version notifies again.
    globalThis.fetch = async url => {
      if (String(url).startsWith("https://api.github.com/")) return { ok: true, status: 200, text: async () => "1.35.0" };
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    const third = await updateChecker.checkNow();
    assert.equal(third.remoteVersion, "1.35.0");
    assert.equal(third.notified, true);
  } finally { restore(); }
});

test("checkNow reports up-to-date without notifying", async () => {
  updateChecker.save({ token: "github_pat_test1234567890" });
  const { calls, restore } = mockFetch(async () => ({ ok: true, status: 200, text: async () => "1.0.0" }));
  try {
    const result = await updateChecker.checkNow();
    assert.equal(result.upToDate, true);
    assert.equal(result.notified, false);
    assert.equal(calls.filter(call => call.url.startsWith("https://hooks.example.com/")).length, 0);
    assert.equal(updateChecker.state().upToDate, true);
  } finally { restore(); }
});

test("checkNow surfaces GitHub failures and records lastError", async () => {
  updateChecker.save({ token: "github_pat_test1234567890" });
  const { restore } = mockFetch(async () => ({ ok: false, status: 401, text: async () => "" }));
  try {
    await assert.rejects(() => updateChecker.checkNow(), /Token 无效/);
    assert.match(updateChecker.state().lastError, /Token 无效/);
  } finally { restore(); }
});

test("missing token rejects with a named error", async () => {
  updateChecker.save({ clear: ["token"] });
  await assert.rejects(() => updateChecker.checkNow(), /尚未配置/);
  // Restore for any later test or manual runs against this DATA_DIR.
  updateChecker.save({ token: "github_pat_test1234567890" });
});

test("state persists across module reloads via the data dir", () => {
  const before = updateChecker.state();
  assert.ok(before.lastCheckAt, "previous tests wrote state");
  updateChecker._internals._reset();
  assert.equal(updateChecker.state().lastCheckAt, before.lastCheckAt);
});
