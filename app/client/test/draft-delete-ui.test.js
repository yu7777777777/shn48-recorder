import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const express = require("express");
const { chromium } = require("playwright");
test("draft cards confirm or cancel deletion and keep failed drafts visible", async () => {
  const app = express();
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let items = [{ draftId: "3834082", title: "在香港的直播", updatedAt: "2026-09-03T14:49:17Z" }, { draftId: "3833795", title: "在深圳的直播" }, { draftId: "", title: "缺少标识的草稿" }];
    let requests = 0;
    let fail = true;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (route.request().method() === "DELETE") {
        requests++;
        assert.equal(url.pathname, "/api/admin/bilibili/draft/3834082");
        assert.deepEqual(route.request().postDataJSON(), { confirmed: true });
        if (fail) return send({ success: false, error: "模拟 B站暂时不可用" }, 502);
        items = items.filter((item) => item.draftId !== "3834082");
        return send({ success: true, data: { deleted: true } });
      }
      if (url.pathname.endsWith("/drafts")) return send({ success: true, data: items, summary: { total: items.length } });
      if (url.pathname.endsWith("/queue")) return send({ success: true, data: [] });
      return send({ success: true, authenticated: true, data: { authenticated: true, uname: "测试账号", health: "ok" } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/bilibili`);
    const button = page.getByRole("button", { name: "删除草稿：在香港的直播", exact: true });
    await button.waitFor();
    assert.equal(await page.getByRole("button", { name: "删除草稿：缺少标识的草稿", exact: true }).isDisabled(), true);
    await button.click();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.getByRole("dialog").innerText(), /服务器录像和上传历史会保留/);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(requests, 0);
    await button.click();
    await page.getByRole("button", { name: "确认删除草稿", exact: true }).click();
    await page.getByText("模拟 B站暂时不可用", { exact: true }).waitFor();
    assert.equal(await button.count(), 1);
    fail = false;
    await page.getByRole("button", { name: "确认删除草稿", exact: true }).click();
    await page.getByText("已删除 B站草稿，服务器录像已保留", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "B站草稿箱 (2 篇)", exact: true }).waitFor();
    assert.equal(await button.count(), 0);
    assert.equal(requests, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.UI_SCREENSHOT) await page.locator(".public-live-grid").screenshot({ path: process.env.UI_SCREENSHOT });
  } finally { await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
