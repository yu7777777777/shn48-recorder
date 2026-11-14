"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const draft = require("../modules/bilibili/draft");
test("draft cover update preserves all metadata, uses update rather than add and verifies upstream", async () => {
  let detail = { id: 123, title: "原题", videos: [{ filename: "private-upos", cid: 321, title: "分P" }], cover: "https://i0.hdslb.com/bfs/archive/old.jpg", subtitle: { open: 1, lan: "zh" }, topic_id: 99, extra: { preserve: true } };
  let written, code = 0, backup;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/view")) return res.end(JSON.stringify({ code: 0, data: detail }));
    assert.ok(req.url.startsWith("/update"));
    let body = ""; for await (const chunk of req) body += chunk;
    written = JSON.parse(body);
    if (code === 0) detail = written;
    res.end(JSON.stringify({ code }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.BILI_DRAFT_VIEW_URL = `http://127.0.0.1:${server.address().port}/view`;
  process.env.BILI_DRAFT_UPDATE_URL = `http://127.0.0.1:${server.address().port}/update`;
  try {
    const options = { draftId: "123", cover: "https://i0.hdslb.com/bfs/archive/new.jpg", cookie: "test-session", csrf: "test-csrf", beforeWrite: d => { backup = structuredClone(d); } };
    const result = await draft.updateDraftCover(options);
    assert.equal(result.verified, true);
    assert.equal(backup.cover, "https://i0.hdslb.com/bfs/archive/old.jpg");
    assert.equal(written.cover, options.cover);
    assert.equal(written.id, 123);
    assert.deepEqual(written.extra, { preserve: true });
    assert.deepEqual(written.subtitle, { open: 1, lan: "zh" });
    assert.equal(written.videos[0].filename, "private-upos");
    code = -101;
    await assert.rejects(draft.updateDraftCover(options), /同步草稿封面/);
    await assert.rejects(draft.updateDraftCover({ ...options, draftId: "../123" }), /ID/);
    detail = { id: 123, videos: [] };
    await assert.rejects(draft.updateDraftCover(options), /视频信息/);
  } finally { server.close(); delete process.env.BILI_DRAFT_VIEW_URL; delete process.env.BILI_DRAFT_UPDATE_URL; }
});
