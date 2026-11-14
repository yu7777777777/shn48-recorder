import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { firstMessageAfter, normalizeReplayDanmakuList, replayDanmakuAt } from "../src/lib/replayDanmaku.js";

test("replay danmaku normalization is bounded, sorted and rejects invalid timestamps", () => {
  const list = normalizeReplayDanmakuList([
    { id: "later", atMs: 2000, nickname: " 用户二 ", text: " 后一条 " },
    { id: "bad", atMs: -1, nickname: "用户", text: "无效" },
    { id: "first", atMs: 1000, nickname: "用户一", text: "第一条\n弹幕" },
  ]);
  assert.deepEqual(list, [
    { id: "first", atMs: 1000, nickname: "用户一", text: "第一条 弹幕" },
    { id: "later", atMs: 2000, nickname: "用户二", text: "后一条" },
  ]);
});

test("replay danmaku cursor starts strictly after the current playback time", () => {
  const messages = [1000, 2000, 2000, 3000].map((atMs, index) => ({ atMs, id: String(index) }));
  assert.equal(firstMessageAfter(messages, 0), 0);
  assert.equal(firstMessageAfter(messages, 1999), 1);
  assert.equal(firstMessageAfter(messages, 2000), 3);
  assert.equal(firstMessageAfter(messages, 9999), 4);
});

test("replay danmaku panel follows backward and forward seeks", () => {
  const messages = [1000, 2000, 3000, 4000].map((atMs, index) => ({ atMs, id: String(index) }));
  assert.deepEqual(replayDanmakuAt(messages, 3500).map(item => item.atMs), [1000, 2000, 3000]);
  assert.deepEqual(replayDanmakuAt(messages, 1500).map(item => item.atMs), [1000]);
  assert.deepEqual(replayDanmakuAt(messages, 9999, 2).map(item => item.atMs), [3000, 4000]);
});

test("replay danmaku loading is not cancelled by its own loading status update", () => {
  const source = fs.readFileSync(new URL("../src/components/ReplayDanmakuOverlay.jsx", import.meta.url), "utf8");
  assert.match(source, /\}, \[enabled, normalizedReplayId, available\]\);/);
  assert.doesNotMatch(source, /\[enabled, normalizedReplayId, available, status\]/);
  assert.match(source, /replay-danmaku-panel/);
  assert.doesNotMatch(source, /replay-danmaku-layer/);
});

test("replay danmaku list scrolls inside a height-constrained desktop player", () => {
  const styles = fs.readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(styles, /\.replay-player-shell \{\s*aspect-ratio: 16 \/ 9;/);
  assert.match(styles, /\.replay-danmaku-panel \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(styles, /\.replay-danmaku-list \{[^}]*overflow-y: auto;/);
});
