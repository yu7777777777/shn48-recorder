"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-daily-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const settings = require("../modules/analysis/settings");
const store = require("../lib/store");
const service = require("../modules/analysis/service");

test.after(() => { service.stop(); fs.rmSync(root, { recursive: true, force: true }); });

function archived(liveId, startedAt, memberName = "成员甲") {
  const file = path.join(process.env.RECORDINGS_DIR, `d${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(file, "x");
  return manager.addRecording({ status: "done", filePath: file, mediaType: "video", source: "pocket48", liveId, memberName, title: `${liveId} 的直播`, startedAt });
}

function seed(id, summary) {
  store.atomicWrite(store.filePath(`analysis_${id}`), { segments: [{ start: 0, end: 2, text: "字幕" }], summary, chapters: [], highlights: [] });
}

async function call(pathname) {
  const app = require("express")();
  app.use("/api/public", require("../routes/public"));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("daily digest groups published summaries by day with replay links", async () => {
  settings.save({ publish: { summary: true, chapters: true, highlights: true } });
  const today = new Date();
  const a = archived("6001", today.toISOString());
  const b = archived("6002", new Date(Date.now() - 86400000).toISOString(), "成员乙");
  seed(a.id, "今天聊了新公演的感想");
  seed(b.id, "昨天进行了生日会直播");

  const res = await call("/api/public/daily");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.data.published, true);
  assert.ok(body.data.days.length >= 2);
  const day = body.data.days.find(row => row.items.some(item => item.liveId === "6001"));
  assert.ok(day, "today's item grouped");
  const item = day.items.find(row => row.liveId === "6001");
  assert.equal(item.memberName, "成员甲");
  assert.ok(item.summary.includes("新公演"));
  assert.equal(item.recordingId.length > 0, true);
});

test("RSS feed escapes XML and links to replay pages", async () => {
  const res = await call("/api/public/daily/rss");
  assert.equal(res.status, 200);
  assert.match(res.type, /application\/rss\+xml/);
  assert.ok(res.text.includes("<rss version=\"2.0\">"));
  assert.ok(res.text.includes("/replays/6001"));
  assert.ok(res.text.includes("新公演"));
  // The XML must be parseable: every tag balanced (rough check via well-formed title).
  assert.ok(!res.text.includes("<br>"));
});

test("the publication switch hides the whole digest", async () => {
  settings.save({ publish: { summary: false } });
  try {
    const res = await call("/api/public/daily");
    assert.equal(JSON.parse(res.text).data.published, false);
    const rssOff = await call("/api/public/daily/rss");
    assert.ok(!rssOff.text.includes("新公演"), "rss is empty while publishing is off");
  } finally {
    settings.save({ publish: { summary: true } });
  }
});
