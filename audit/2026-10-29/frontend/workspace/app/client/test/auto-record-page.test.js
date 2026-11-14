import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("auto-record page keeps the React namespace required by the production JSX transform", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /import\s+React\s*,\s*\{\s*useCallback/);
  assert.match(source, /export default function AutoRecordPage\s*\(/);
});

test("auto-record page uses alert severity classes without duplicating login errors", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /admin-alert \$\{messageType\}/);
  assert.match(source, /admin-alert info.*自动录制、公开直播和成员名单均不依赖/s);
  assert.match(source, /loginError && <div className="admin-alert error"/);
  assert.match(source, /config\.maxConcurrent >= 5 &&/);
  assert.doesNotMatch(source, /设置 20 路代表允许并发尝试/);
});

test("auto-record page distinguishes invalid credentials and does not make recording depend on login", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /credentialsInvalid/);
  assert.match(source, /凭据失效/);
  assert.match(source, /自动录制仍使用公开直播数据/);
  assert.match(source, /重新登录/);
});

test("auto-record page uses SMS verification as the primary Pocket48 login", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /useState\("sms"\)/);
  assert.match(source, /\/pocket48\/login\/sms\/send/);
  assert.match(source, /\/pocket48\/login\/sms\/verify/);
  assert.match(source, /验证码不会保存/);
  assert.match(source, /autoComplete="one-time-code"/);
  assert.doesNotMatch(source, /手机号密码/);
  assert.match(source, /current-password/);
});

test("auto-record page loads a searchable roster without asking users to discover ids", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /\/pocket48\/members/);
  assert.match(source, /共 \{members\.length\} 位现役成员/);
  assert.match(source, /groupIds\.includes\(groupId\)/);
  assert.match(source, /<details className="manual-member-details"/);
  assert.doesNotMatch(source, /暂无成员名单，可直接用上方 ID 添加/);
});

test("auto-record page preserves normalized backend member names", async () => {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
  });

  try {
    const { normalizeMember } = await vite.ssrLoadModule("/src/pages/AutoRecord.jsx");
    assert.deepEqual(normalizeMember({ memberId: "42", memberName: "刘姝贤", groupId: "10:104", groupName: "SNH48 · Team X" }), {
      id: "42",
      name: "刘姝贤",
      avatar: "",
      groupId: "10:104",
      groupIds: ["10:104"],
      groupName: "SNH48 · Team X",
    });
  } finally {
    await vite.close();
  }
});

test("auto-record member filters select an organization before a team", async () => {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
  });

  try {
    const { filterMembers } = await vite.ssrLoadModule("/src/pages/AutoRecord.jsx");
    const members = [
      { id: "1", name: "甲", groupIds: ["10:101"] },
      { id: "2", name: "乙", groupIds: ["20:201"] },
    ];
    assert.deepEqual(filterMembers(members, "", "", "10").map(item => item.id), ["1"]);
    assert.deepEqual(filterMembers(members, "", "20:201", "20").map(item => item.id), ["2"]);
  } finally {
    await vite.close();
  }

  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");
  assert.match(source, /团体筛选/);
  assert.match(source, /请先选择团体/);
  assert.match(source, /setGroupId\(""\)/);
});

test("member selection preserves the admin scroll position", async () => {
  const source = await readFile(new URL("../src/pages/AutoRecord.jsx", import.meta.url), "utf8");

  assert.match(source, /useLayoutEffect/);
  assert.match(source, /memberScrollTop/);
  assert.match(source, /onPointerDown=\{rememberMemberScroll\}/);
  assert.match(source, /scroller\.scrollTop = memberScrollTop\.current/);
});

test("auto-record page imports and renders without a missing React namespace", async () => {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
  });

  try {
    const { default: AutoRecordPage } = await vite.ssrLoadModule("/src/pages/AutoRecord.jsx");
    const html = renderToStaticMarkup(React.createElement(AutoRecordPage));
    assert.match(html, /自动录制/);
  } finally {
    await vite.close();
  }
});
