import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("archive UI explains segment joining and plays finalized MP4 files", async () => {
  const [page, player] = await Promise.all([
    readFile(new URL("../src/pages/Video.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/VideoPlayer.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /自动录制支持官方回放补全/);
  assert.match(page, /已合并 \$\{item\.segmentCount\} 个片段/);
  assert.match(page, /waiting_merge: "等待续播"/);
  assert.match(page, /type: mediaType\(playing\)/);
  assert.match(player, /\["hls", "flv", "mp4"\]/);
  assert.match(player, /video\.src = url/);
});

test("archive UI exposes manual repost for repaired local archives", async () => {
  const page = await readFile(new URL("../src/pages/Video.jsx", import.meta.url), "utf8");

  assert.match(page, /item\.replayRecovery\?\.status === "replaced"/);
  assert.match(page, /重新投稿/);
  assert.match(page, /\/recordings\/\$\{encodeURIComponent\(item\.id\)\}\/reupload/);
  assert.match(page, /原有投稿保持不变/);
});
