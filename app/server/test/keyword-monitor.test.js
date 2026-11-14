"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-kw-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const monitor = require("../modules/pocket48/keyword-monitor");
const api = require("../modules/pocket48/api");
const notify = require("../modules/notify");

test.after(() => { monitor.stop(); fs.rmSync(root, { recursive: true, force: true }); });

// 配置校验：房间号必须是数字、关键词去重并限量、轮询间隔有界。
test("save validates rooms, keywords and interval bounds", () => {
  assert.throws(() => monitor.save({ rooms: [{ roomId: "abc" }] }), /数字房间/);
  assert.throws(() => monitor.save({ keywords: "直播" }), /关键词列表无效/);
  assert.throws(() => monitor.save({ pollSeconds: 5 }), /轮询间隔/);
  assert.throws(() => monitor.save({ cooldownMinutes: 99999 }), /冷却/);
  const status = monitor.save({
    enabled: true,
    keywords: ["直播", "官宣", "直播", "  ", ""],
    rooms: [{ roomId: "123456", name: "测试房间" }, { roomId: "123456", name: "重复" }],
    pollSeconds: 45,
    cooldownMinutes: 10,
  });
  assert.deepEqual(status.keywords, ["直播", "官宣"], "deduped and trimmed");
  assert.equal(status.rooms.length, 1);
  assert.equal(status.rooms[0].roomId, "123456");
  assert.equal(status.pollSeconds, 45);
  assert.equal(status.running, false, "start() has not been called");
});

// 轮询命中：stub 掉口袋48 api，验证命中 → 通知事件 + 命中记录 + 冷却去重。
test("poll matches keywords, notifies once per cooldown and logs hits", async () => {
  monitor.save({
    enabled: true,
    keywords: ["直播"],
    rooms: [{ roomId: "888", name: "成员房间" }],
    cooldownMinutes: 30,
  });
  const events = [];
  const originalEvent = notify.event;
  notify.event = (name, payload) => { if (name === "pocket48_keyword") events.push(payload); };
  const originalMessages = api.getRoomMessages;
  let calls = 0;
  api.getRoomMessages = async () => ({
    status: 200,
    data: {
      status: 200,
      content: {
        message: [
          { idClient: "m1", msgType: "TEXT", custom: JSON.stringify({ messageType: "BARRAGE_MEMBER", text: "今晚八点开直播哦", user: { nickName: "成员本人" } }) },
          { idClient: "m2", msgType: "TEXT", custom: JSON.stringify({ text: "今天天气不错", user: { nickName: "路人" } }) },
          { idClient: "m1", msgType: "TEXT", custom: JSON.stringify({ messageType: "BARRAGE_MEMBER", text: "今晚八点开直播哦", user: { nickName: "成员本人" } }) },
        ],
      },
    },
  });
  try {
    await monitor.poll(true);
    assert.equal(calls, 0);
    assert.equal(events.length, 1, "duplicate message id only notifies once");
    assert.equal(events[0].keyword, "直播");
    assert.equal(events[0].nickname, "成员本人");
    assert.equal(events[0].roomName, "成员房间");
    assert.ok(events[0].text.includes("今晚八点"));
    const status = monitor.status();
    assert.equal(status.matches.length, 1);
    assert.equal(status.lastError, null);
    assert.ok(status.lastRunAt);
    // Cooldown window: even a fresh message with the same keyword is silent.
    api.getRoomMessages = async () => ({
      status: 200,
      data: { status: 200, content: { message: [{ idClient: "m3", msgType: "TEXT", custom: JSON.stringify({ text: "直播马上开始", user: { nickName: "成员本人" } }) }] } },
    });
    await monitor.poll(true);
    assert.equal(events.length, 1, "cooldown suppresses repeat notifications");
    assert.equal(monitor.status().matches.length, 1);
  } finally {
    notify.event = originalEvent;
    api.getRoomMessages = originalMessages;
  }
});

// 上游故障只记录 lastError，不影响下一个房间的轮询，也不抛出。
test("upstream failures record lastError instead of throwing", async () => {
  monitor.save({ enabled: true, keywords: ["直播"], rooms: [{ roomId: "777", name: "坏房间" }], cooldownMinutes: 0 });
  const originalMessages = api.getRoomMessages;
  api.getRoomMessages = async () => { throw new Error("口袋48请求失败"); };
  try {
    await assert.doesNotReject(() => monitor.poll(true));
    assert.match(monitor.status().lastError || "", /口袋48请求失败/);
  } finally {
    api.getRoomMessages = originalMessages;
  }
});

// 冷却时间戳持久化：重启（重新加载模块状态）后同一命中不再重复推送。
test("cooldown timestamps survive a restart via the persisted state file", async () => {
  monitor.save({ enabled: true, keywords: ["直播"], rooms: [{ roomId: "999", name: "重启房间" }], cooldownMinutes: 30 });
  const events = [];
  const originalEvent = notify.event;
  notify.event = (name, payload) => { if (name === "pocket48_keyword") events.push(payload); };
  const originalMessages = api.getRoomMessages;
  api.getRoomMessages = async () => ({
    status: 200,
    data: { status: 200, content: { message: [{ idClient: "r1", msgType: "TEXT", custom: JSON.stringify({ text: "直播要开始了", user: { nickName: "成员" } }) }] } },
  });
  const store = require("../lib/store");
  try {
    await monitor.poll(true);
    assert.equal(events.length, 1);
    // The debounce writes within ~2s.
    await new Promise(resolve => setTimeout(resolve, 2300));
    const persisted = store.load("keyword_monitor_state", {});
    assert.ok(Object.keys(persisted).some(key => key.startsWith("999:")), "cooldown key persisted");
    assert.equal(events.length, 1);
  } finally {
    notify.event = originalEvent;
    api.getRoomMessages = originalMessages;
  }
});
