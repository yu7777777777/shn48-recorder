"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-notify-"));
process.env.DATA_DIR = path.join(root, "data");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const notify = require("../modules/notify");
const smtp = require("../modules/notify/smtp");
const channels = require("../modules/notify/channels");
const store = require("../lib/store");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("settings save validates channels, events and thresholds, and masks secrets", () => {
  assert.throws(() => notify.save({ channels: { telegram: { botToken: "not-a-token" } } }), /Bot Token/);
  assert.throws(() => notify.save({ channels: { webhook: { url: "ftp://x" } } }), /http/);
  assert.throws(() => notify.save({ events: { nope: true } }), /事件开关/);
  assert.throws(() => notify.save({ failures: { threshold: 0 } }), /1-50/);
  assert.throws(() => notify.save({ channels: { unknown: {} } }), /通道配置无效/);

  const saved = notify.save({
    enabled: true,
    channels: {
      telegram: { enabled: true, botToken: "123456789:AAabcdefghij1234567890AB", chatId: "-100123" },
      webhook: { enabled: true, url: "https://hooks.example.com/x", secret: "s3cret" },
    },
    failures: { threshold: 2, cooldownMinutes: 30 },
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.channels.telegram.botTokenSet, true);
  assert.equal(saved.channels.telegram.botToken, undefined, "token never leaves the server");
  assert.equal(saved.channels.webhook.secretSet, true);
  assert.equal(saved.channels.webhook.url, "https://hooks.example.com/x");
  assert.equal(saved.failures.threshold, 2);
  // Re-saving without the secret must not erase the stored one.
  notify.save({ channels: { telegram: { chatId: "-100124" } } });
  assert.equal(notify.publicSettings().channels.telegram.botTokenSet, true);
  assert.equal(notify.publicSettings().channels.telegram.chatId, "-100124");
});

test("event() sends to enabled channels and logs the delivery", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  try {
    // Singleton settings persist across tests in this file: isolate the webhook
    // channel explicitly so delivery goes to exactly one channel.
    notify.save({
      enabled: true,
      channels: {
        telegram: { enabled: false }, email: { enabled: false }, serverchan: { enabled: false }, bark: { enabled: false },
        webhook: { enabled: true, url: "https://hooks.example.com/hook", secret: "k1" },
      },
      events: { recording_failed: true, backup_done: false },
    });
    notify.event("recording_failed", { title: "某场直播", memberName: "成员甲", error: "磁盘空间不足" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("https://hooks.example.com/hook"));
    assert.equal(calls[0].body.event, "recording_failed");
    assert.ok(calls[0].body.title.includes("录制失败"));
    assert.ok(calls[0].body.text.includes("磁盘空间不足"));
    const log = notify.deliveryLog();
    assert.equal(log[0].channel, "webhook");
    assert.equal(log[0].ok, true);
    // Disabled event switch suppresses delivery entirely.
    calls.length = 0;
    notify.event("backup_done", { title: "某场直播" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0, "event switch off means no delivery");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consecutive failures raise one alert per threshold/cooldown window", async () => {
  const alerts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.event === "failure_alert") alerts.push(body);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    notify.save({
      enabled: true,
      channels: {
        telegram: { enabled: false }, email: { enabled: false }, serverchan: { enabled: false }, bark: { enabled: false },
        webhook: { enabled: true, url: "https://hooks.example.com/alert" },
      },
      events: { failure_alert: true, upload_failed: true },
      failures: { threshold: 2, cooldownMinutes: 60 },
    });
    notify._internals.resetCounters();
    notify.event("upload_failed", { title: "A", error: "x" });
    notify.event("upload_failed", { title: "A", error: "y" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alerts.length, 1, "first alert at threshold");
    assert.ok(alerts[0].text.includes("2 次连续失败"));
    // Cooldown suppresses a second alert within the window.
    notify.event("upload_failed", { title: "A", error: "z" });
    notify.event("upload_failed", { title: "A", error: "w" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alerts.length, 1, "cooldown window suppresses repeats");
    // A success resets the counter.
    notify.event("upload_done", { title: "A" });
    notify.event("upload_failed", { title: "A", error: "x" });
    notify.event("upload_failed", { title: "A", error: "x" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alerts.length, 1, "counter reset by success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("test() refuses channels without saved credentials", async () => {
  notify.save({ channels: { bark: { deviceKey: "" } } });
  await assert.rejects(() => notify.test("bark"), /deviceKey/);
  await assert.rejects(() => notify.test("email"), /SMTP 服务器/);
  notify.save({ channels: { serverchan: { sendKey: "SCT1234567890abcdefghijklm" } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });
  try {
    await assert.doesNotReject(() => notify.test("serverchan"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("smtp message builder emits CRLF, MIME-B headers and dot-stuffing", () => {
  const body = smtp._internals.message({ from: "a@example.com", to: "b@example.com", subject: "录制完成：测试", text: "第一行\n第二行\n.点开头" });
  assert.ok(body.includes("Subject: =?UTF-8?B?"), "non-ASCII subject must be MIME B-encoded");
  assert.ok(!/(?<!\r)\n/.test(body), "every LF must be preceded by CR (CRLF body)");
  assert.ok(body.includes("\r\n第一行\r\n"));
  assert.ok(body.includes("\r\n..点开头"), "leading dots are stuffed");
  assert.ok(smtp._internals.encodeHeader("plain ascii") === "plain ascii");
  assert.throws(() => smtp._internals.normalizeHost("bad host!"), /SMTP 服务器地址/);
});

test("channel URL guard rejects non-http and credentialed URLs", () => {
  assert.throws(() => channels._internals.assertHttpUrl("javascript:alert(1)", "地址"), /http/);
  assert.throws(() => channels._internals.assertHttpUrl("https://user:pass@example.com/x", "地址"), /账号密码/);
  assert.equal(channels._internals.assertHttpUrl("https://example.com/x/", "地址"), "https://example.com/x");
});

test("the master switch gates every outbound send including failure alerts", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).event);
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  try {
    notify.save({
      enabled: false,
      channels: {
        telegram: { enabled: false }, email: { enabled: false }, serverchan: { enabled: false }, bark: { enabled: false },
        webhook: { enabled: true, url: "https://hooks.example.com/gate" },
      },
      events: { upload_failed: true, failure_alert: true },
      failures: { threshold: 1, cooldownMinutes: 60 },
    });
    notify._internals.resetCounters();
    notify.event("upload_failed", { title: "A", error: "down" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0, "no outbound traffic while disabled");
    notify.save({ enabled: true });
    notify.event("upload_failed", { title: "A", error: "down" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.includes("upload_failed"));
    assert.ok(calls.includes("failure_alert"), "threshold=1 fires the alert once enabled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clear flags remove stored credentials; empty inputs still keep them", () => {
  notify.save({ channels: { bark: { deviceKey: "AbCdEf123456" }, telegram: { botToken: "123456789:AAabcdefghij1234567890AB" } } });
  assert.equal(notify.publicSettings().channels.bark.deviceKeySet, true);
  notify.save({ channels: { bark: {} } });
  assert.equal(notify.publicSettings().channels.bark.deviceKeySet, true, "absent secret keeps the stored one");
  notify.save({ channels: { bark: { clear: ["deviceKey"] }, telegram: { clear: ["deviceKey"] } } });
  assert.equal(notify.publicSettings().channels.bark.deviceKeySet, false, "clear removes the credential");
  assert.equal(notify.publicSettings().channels.telegram.botTokenSet, true, "clearing an unrelated field is a no-op");
});

test("recording_done fires once per archive: re-encode (done→processing→done) stays silent", async () => {
  process.env.RECORDINGS_DIR = path.join(root, "recordings");
  fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
  const manager = require("../modules/recorder/manager");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).event);
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  try {
    notify.save({
      enabled: true,
      channels: {
        telegram: { enabled: false }, email: { enabled: false }, serverchan: { enabled: false }, bark: { enabled: false },
        webhook: { enabled: true, url: "https://hooks.example.com/lifecycle" },
      },
      events: { recording_done: true, recording_started: false, recording_failed: false },
    });
    notify._internals.resetCounters();
    const file = path.join(process.env.RECORDINGS_DIR, "lc1.mp4");
    fs.writeFileSync(file, "x");
    const rec = manager.addRecording({ status: "recording", source: "pocket48", liveId: "5501", title: "生命周期" });
    manager.updateRecording(rec.id, { status: "waiting_merge" });
    manager.updateRecording(rec.id, { status: "done", duration: 60 });
    assert.ok(calls.includes("recording_done"), "first archive notifies");
    // Re-encode for upload: done → processing → done must not re-notify.
    manager.updateRecording(rec.id, { status: "processing" });
    manager.updateRecording(rec.id, { status: "done", duration: 60 });
    manager.updateRecording(rec.id, { status: "archive_failed", archiveError: "x" });
    manager.updateRecording(rec.id, { status: "done", duration: 60 });
    const doneCount = calls.filter(name => name === "recording_done").length;
    assert.equal(doneCount, 2, "first archive + failed-retry archive, not the silent re-encode");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
