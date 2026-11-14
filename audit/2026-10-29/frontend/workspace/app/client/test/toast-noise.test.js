import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("toasts collapse repeated identical errors and cap the stack", async () => {
  const toast = await source("components/Toast.jsx");
  assert.match(toast, /const MAX_VISIBLE = 3/);
  assert.match(toast, /const DEDUPE_MS = 60_000/);
  assert.match(toast, /lastErrorKey/);
  assert.match(toast, /repeats: \(t\.repeats \|\| 1\) \+ 1/);
  assert.match(toast, /slice\(-MAX_VISIBLE\)/);
  assert.match(toast, /已重复/);
  assert.match(toast, /useRef/);
});

test("auto-record page does not duplicate its inline alert with a toast", async () => {
  const page = await source("pages/AutoRecord.jsx");
  assert.doesNotMatch(page, /notify\(errorMessage\(err, "成员名单加载失败，请稍后重试"\), "error"\);\s*\n\s*toast\.error/);
  assert.doesNotMatch(page, /toast\.error\(errorMessage\(error, "保存失败"\)\)/);
  assert.match(page, /if \(announce\) notify\(message, "error"\)/);
  assert.match(page, /load\(\{ refresh: true, announce: true \}\)/);
});

test("archive list polling reports failures inline instead of per-interval popups", async () => {
  const page = await source("pages/Video.jsx");
  assert.match(page, /const \[listError, setListError\] = useState\(""\)/);
  assert.match(page, /setListError\(errorMessage\(requestError, "归档列表获取失败"\)\)/);
  assert.doesNotMatch(page, /toast\.error\(errorMessage\(requestError, "归档列表获取失败"\)\)/);
  assert.match(page, /\{listError && \(/);
  assert.match(page, /const loadRecordings = useCallback\(async \(\) => \{[\s\S]*?\}, \[\]\);/);
});
