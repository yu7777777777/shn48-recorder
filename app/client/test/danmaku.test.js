import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDanmakuMessage, safeLiveId } from "../src/lib/danmaku.js";

test("danmaku normalization exposes only bounded display text", () => {
  const normalized = normalizeDanmakuMessage({
    idClient: "message-1",
    type: "custom",
    custom: JSON.stringify({
      messageType: "BARRAGE_MEMBER",
      text: "  直播真好看\n ",
      token: "must-not-leak",
      user: { nickName: "测试观众", userId: 42, avatar: "https://private.example/avatar" },
    }),
  });

  assert.deepEqual(normalized, { id: "message-1", nickname: "测试观众", text: "直播真好看", member: true });
  assert.equal(JSON.stringify(normalized).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(normalized).includes("private.example"), false);
});

test("danmaku normalization accepts safe server DTOs and rejects invalid live ids", () => {
  assert.deepEqual(normalizeDanmakuMessage({ id: "safe-1", nickname: "观众", text: "你好", member: false, token: "ignored" }), {
    id: "safe-1", nickname: "观众", text: "你好", member: false,
  });
  assert.equal(normalizeDanmakuMessage({ type: "custom", custom: "not-json" }), null);
  assert.equal(normalizeDanmakuMessage({ type: "custom", custom: JSON.stringify({ messageType: "PRESENT_NORMAL" }) }), null);
  assert.equal(safeLiveId("1301199019986194432"), "1301199019986194432");
  assert.equal(safeLiveId("1301<script>"), "");
});
