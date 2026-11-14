import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsSource = fs.readFileSync(new URL("../src/pages/Config.jsx", import.meta.url), "utf8");
const publicLiveSource = fs.readFileSync(new URL("../src/pages/PublicLive.jsx", import.meta.url), "utf8");
const playerSource = fs.readFileSync(new URL("../src/components/VideoPlayer.jsx", import.meta.url), "utf8");

test("admin settings expose both live playback priorities", () => {
  assert.match(settingsSource, /直播播放策略/);
  assert.match(settingsSource, /value="direct_first"/);
  assert.match(settingsSource, /value="server"/);
  assert.match(settingsSource, /连接失败时自动申请服务器中转代理/);
});

test("public live silently requests server fallback without displaying the strategy", () => {
  assert.match(publicLiveSource, /params: \{ fallback: "server" \}/);
  assert.match(publicLiveSource, /onFallback=/);
  assert.doesNotMatch(publicLiveSource, /直连优先|服务器中转/);
  assert.match(playerSource, /const tryFallback = \(\) =>/);
  assert.match(playerSource, /if \(!tryFallback\(\)\) showError/);
});
