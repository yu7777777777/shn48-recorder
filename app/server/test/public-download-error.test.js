"use strict";
// A public visitor may only ever see the preset Chinese failure reasons that
// replay-download marks with `error.preset`. Raw fs/network errors must fall
// back to the generic sentence without leaking paths, URLs or stack details.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-download-error-"));
for (const name of ["DATA_DIR", "POCKET48_DATA_DIR", "RECORDINGS_DIR", "COVERS_DIR"]) process.env[name] = path.join(root, name.toLowerCase());
process.env.CONFIG_PATH = path.join(root, "config.yaml");
const express = require("express");
const replayService = require("../modules/pocket48/replay");
const replayDownload = require("../modules/recorder/replay-download");
const app = express();
app.use(require("../routes/public"));
const server = app.listen(0, "127.0.0.1");
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
const basePromise = new Promise((resolve, reject) => { server.once("listening", () => resolve(`http://127.0.0.1:${server.address().port}`)); server.once("error", reject); });

async function failedDownloadError(liveId, failure) {
  const base = await basePromise;
  const originalGetReplay = replayService.getReplay;
  const originalDownload = replayDownload.downloadShared;
  replayService.getReplay = async () => ({ replay: { liveId, title: "t", member: { id: "1", name: "m" }, startedAt: Date.now() }, streamUrl: "https://idol-vod.48.cn/a.m3u8" });
  replayDownload.downloadShared = async () => { throw failure(); };
  try {
    const started = await fetch(`${base}/replays/${liveId}/download`, { method: "POST" });
    assert.equal(started.status, 202);
    for (let waited = 0; waited < 5000; waited += 20) {
      const status = await (await fetch(`${base}/replays/${liveId}/download/status`)).json();
      if (status.data.status === "failed") return status.data.error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("download job never failed");
  } finally {
    replayService.getReplay = originalGetReplay;
    replayDownload.downloadShared = originalDownload;
  }
}

test("a preset replay-download reason is passed through to the public visitor", async () => {
  const error = await failedDownloadError("7001", () => Object.assign(new Error("官方回放尚未生成完整清单"), { preset: true }));
  assert.equal(error, "官方回放尚未生成完整清单");
});

test("a raw fs/network error falls back to the generic sentence and leaks nothing", async () => {
  const error = await failedDownloadError("7002", () => Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\secret\\asset-00000.ts'"), { code: "ENOENT" }));
  assert.equal(error, "回放暂时无法完整下载，请稍后重试");
  assert.equal(error.includes("secret"), false);
});
