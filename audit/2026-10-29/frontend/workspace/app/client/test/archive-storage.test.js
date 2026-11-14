import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("archive page displays available and total recording-disk capacity", async () => {
  const source = await readFile(new URL("../src/pages/Video.jsx", import.meta.url), "utf8");

  assert.match(source, /adminApi\.get\("\/health"\)/);
  assert.match(source, /可用磁盘/);
  assert.match(source, /总计 \{formatBytes\(storage\.total\)\}/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /storage\.usedPercent/);
});
