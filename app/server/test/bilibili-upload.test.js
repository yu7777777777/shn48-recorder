"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const biliDraft = require("../modules/bilibili/draft");

test("Bilibili upload falls back to a backup endpoint when the primary cannot connect", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-bili-upload-"));
  const videoPath = path.join(tempDir, "test.mp4");
  fs.writeFileSync(videoPath, Buffer.from("test-video"));

  const hits = { init: 0, chunk: 0, finalize: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/preupload") {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.end(JSON.stringify({
        OK: 1,
        auth: "test-auth",
        biz_id: 123,
        chunk_size: 4,
        endpoint: "http://127.0.0.1:1",
        endpoints: ["http://127.0.0.1:1", origin],
        upos_uri: "upos://ugc/test-video.mp4",
      }));
      return;
    }
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      hits.init += 1;
      res.end(JSON.stringify({ upload_id: "upload-1" }));
      return;
    }
    if (req.method === "PUT") {
      hits.chunk += 1;
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ OK: 1 })));
      return;
    }
    if (req.method === "POST" && url.searchParams.get("uploadId") === "upload-1") {
      hits.finalize += 1;
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ OK: 1 })));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousPreuploadUrl = process.env.BILI_PREUPLOAD_URL;
  process.env.BILI_PREUPLOAD_URL = `http://127.0.0.1:${server.address().port}/preupload`;
  try {
    const uploaded = await biliDraft.uploadFileToUpos({
      filePath: videoPath,
      cookie: "SESSDATA=test",
      upcdn: "bda2",
    });
    assert.equal(uploaded.filename, "test-video");
    assert.deepEqual(hits, { init: 1, chunk: 3, finalize: 1 });
  } finally {
    if (previousPreuploadUrl === undefined) delete process.env.BILI_PREUPLOAD_URL;
    else process.env.BILI_PREUPLOAD_URL = previousPreuploadUrl;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
