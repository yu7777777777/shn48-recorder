import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("replay audit page exposes manual official replay import and polling", async () => {
  const page = await readFile(new URL("../src/pages/ReplayAudit.jsx", import.meta.url), "utf8");
  assert.match(page, /手动补录官方回放/);
  assert.match(page, /\/recordings\/replay-import/);
  assert.match(page, /replay-import\/\$\{encodeURIComponent\(jobId\)\}/);
  assert.match(page, /autoUpload/);
  assert.match(page, /uploadQueued/);
});

test("replay session dates accept timestamps and show Beijing time without Invalid Date", async () => {
  const page = await readFile(new URL("../src/pages/ReplayAudit.jsx", import.meta.url), "utf8");
  const source = page.slice(page.indexOf("function replayDate("), page.indexOf("function importStatusText("));
  const format = vm.runInNewContext(source + "\nreplayDate");
  const expected = "2026/9/30 10:00:00";
  const ms = Date.parse("2026-09-30T02:00:00Z");
  for (const value of [ms, String(ms), ms / 1000, String(ms / 1000), "2026-09-30T02:00:00Z", "2026-09-30 10:00:00", "2026-09-30T10:00:00", "2026/09/30 10:00:00"]) {
    assert.equal(format(value), expected);
  }
  for (const value of [undefined, null, "", 0, "bad-date", Number.NaN, Infinity]) {
    assert.equal(format(value), "时间待更新");
  }
  assert.match(page, /\{replayDate\(item\.startedAt\|\|item\.startTime\|\|item\.ctime\|\|item\.createdAt\)\} · \{item\.title/);
});
