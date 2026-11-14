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
const store = require("../lib/store");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// The checker talks to the GitHub Contents API through global fetch.
function mockFetch(github) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.startsWith("https://api.github.com/")) return github(target, init);
    throw new Error(`unexpected fetch: ${target}`);
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

test("checkNow records state against the running version", async () => {
  updateChecker.save({ repo: "owner/repo", branch: "main", token: "github_pat_test1234567890" });
  const { restore } = mockFetch(async target => {
    assert.ok(target.includes("/contents/app/VERSION"), "reads the repo VERSION file");
    assert.ok(target.includes("ref=main"), "pins the configured branch");
    return { ok: true, status: 200, text: async () => "99.0.0\n" };
  });
  try {
    const first = await updateChecker.checkNow();
    assert.equal(first.upToDate, false);
    assert.equal(first.remoteVersion, "99.0.0");
    const state = updateChecker.state();
    assert.equal(state.upToDate, false);
    assert.ok(state.lastCheckAt);
    // Same version again: the state simply refreshes.
    await updateChecker.checkNow();
    assert.equal(updateChecker.state().remoteVersion, "99.0.0");
  } finally { restore(); }
});

test("checkNow reports up-to-date", async () => {
  updateChecker.save({ token: "github_pat_test1234567890" });
  const { restore } = mockFetch(async () => ({ ok: true, status: 200, text: async () => "1.0.0" }));
  try {
    const result = await updateChecker.checkNow();
    assert.equal(result.upToDate, true);
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

test("anonymous checks work without a token and send no Authorization header", async () => {
  updateChecker.save({ clear: ["token"] });
  const { restore } = mockFetch(async (target, init) => {
    assert.equal(init?.headers?.Authorization, undefined, "no Authorization header without a token");
    return { ok: true, status: 200, text: async () => "1.0.0" };
  });
  try {
    const result = await updateChecker.checkNow();
    assert.equal(result.upToDate, true);
  } finally { restore(); }
});

test("state persists across module reloads via the data dir", () => {
  const before = updateChecker.state();
  assert.ok(before.lastCheckAt, "previous tests wrote state");
  updateChecker._internals._reset();
  assert.equal(updateChecker.state().lastCheckAt, before.lastCheckAt);
});
