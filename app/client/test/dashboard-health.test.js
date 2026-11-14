import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("dashboard reports partial and unavailable states from endpoint failures", async () => {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
  });

  try {
    const { getDashboardStatus } = await vite.ssrLoadModule("/src/pages/Dashboard.jsx");
    const healthy = {
      health: "fulfilled",
      recordings: "fulfilled",
      active: "fulfilled",
      lives: "fulfilled",
      uploadQueue: "fulfilled",
    };
    assert.deepEqual(getDashboardStatus(healthy), {
      badge: "healthy",
      label: "运行正常",
      failedRequests: [],
    });

    const partial = { ...healthy, lives: "rejected" };
    const partialStatus = getDashboardStatus(partial);
    assert.equal(partialStatus.badge, "warning");
    assert.equal(partialStatus.label, "部分异常");
    assert.deepEqual(partialStatus.failedRequests.map(({ key }) => key), ["lives"]);

    const unavailable = Object.fromEntries(
      Object.keys(healthy).map((key) => [key, "rejected"])
    );
    assert.equal(getDashboardStatus(unavailable).badge, "failed");
    assert.equal(getDashboardStatus(unavailable).label, "数据暂不可用");
  } finally {
    await vite.close();
  }
});
