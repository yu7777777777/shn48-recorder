import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../src/lib/api.js";

// Pins four UX polish fixes: modal dismissal protection on the social account
// editor, the meta.total archived count on the dashboard, long timeouts for
// the synchronous merge endpoints on the archive page, and Chinese guidance
// for axios network failures. The pages themselves are exercised in a browser;
// these checks catch the regressions a rebuild could hide.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const read = (file) => readFileSync(path.join(src, file), "utf8");

test("social account editor stands down backdrop and Escape while the draft is dirty", () => {
  const page = read("pages/SocialAccounts.jsx");
  const editor = page.slice(page.indexOf("function AccountEditor"), page.indexOf("function placeholderFor"));
  assert.ok(editor.length > 0, "AccountEditor must stay in SocialAccounts.jsx");
  // Dirty is a plain comparison against the initial draft, no form library.
  assert.match(editor, /const dirty = useMemo\(/);
  assert.match(editor, /JSON\.stringify\(draft\) !== JSON\.stringify\(initial\)/);
  // Backdrop click and Escape keep their busy guard and add the dirty guard.
  assert.match(editor, /onClick=\{\(\) => !busy && !dirty && onCancel\(\)\}/);
  assert.match(editor, /event\.key === "Escape" && !busy && !dirty\) onCancel\(\)/);
  assert.match(editor, /\[busy, dirty, onCancel\]/);
  // Explicit dismissal stays available: the X button and 取消 button still close.
  assert.match(editor, /className="modal-close-btn" onClick=\{onCancel\}/);
  const footer = editor.slice(editor.indexOf("modal-footer"));
  assert.match(footer, /onClick=\{onCancel\}/);
  assert.ok(footer.includes("取消"), "cancel button must remain in the footer");
});

test("dashboard reads the archived count from a status-filtered meta.total with a fallback", () => {
  const page = read("pages/Dashboard.jsx");
  // The done-count probe asks for one filtered row and reads meta.total.
  assert.match(page, /adminApi\s*\.get\("\/recordings", \{ params: \{ limit: 1, status: "done" \} \}\)/);
  assert.match(page, /\.then\(\(response\) => setDoneTotal\(recordingsMetaTotal\(response\)\)\)/);
  assert.match(page, /\.catch\(\(\) => setDoneTotal\(null\)\)/);
  // meta access defends against undefined and falls back to the ≤10 count.
  assert.match(page, /response\?\.data\?\.meta\?\.total/);
  assert.match(page, /doneTotal \?\? recordings\.filter\(\(item\) => item\.status === "done"\)\.length/);
  // The preview list keeps its own request; its total (all statuses) feeds the
  // 共计 label, falling back to the truncated list length.
  assert.match(page, /adminApi\.get\("\/recordings", \{ params: \{ limit: 10 \} \}\)/);
  assert.match(page, /recordingTotal \?\? recordings\.length/);
  // The probe must stay outside Promise.allSettled: the five-panel status
  // contract of getDashboardStatus is pinned by dashboard-health.test.js.
  const requests = page.slice(page.indexOf("const DASHBOARD_REQUESTS"), page.indexOf("export function getDashboardStatus"));
  assert.equal([...requests.matchAll(/key: "/g)].length, 5, "DASHBOARD_REQUESTS must keep exactly five panels");
  const settled = page.slice(page.indexOf("await Promise.allSettled"), page.indexOf("await doneCountRequest"));
  assert.ok(!settled.includes('status: "done"'), "the done-count probe must not join the status-tracked requests");
});

test("recordingsMetaTotal parses meta.total defensively", () => {
  // The helper is a pure function, so its exact source is lifted from the page
  // and executed here; a browser-level render is covered elsewhere.
  const page = read("pages/Dashboard.jsx");
  const start = page.indexOf("export function recordingsMetaTotal");
  assert.ok(start >= 0, "recordingsMetaTotal must stay exported from Dashboard.jsx");
  const end = page.indexOf("\n}", start);
  assert.ok(end > start, "recordingsMetaTotal must keep its single-function shape");
  const fnSource = `${page.slice(start, end + 2).replace(/^export /, "")}; return recordingsMetaTotal;`;
  const recordingsMetaTotal = new Function(fnSource)();

  assert.equal(recordingsMetaTotal({ data: { meta: { total: 42 } } }), 42);
  assert.equal(recordingsMetaTotal({ data: { meta: { total: 0 } } }), 0);
  assert.equal(recordingsMetaTotal({ data: { meta: { total: "7" } } }), 7);
  // Old backends and malformed payloads fall back instead of lying.
  assert.equal(recordingsMetaTotal({ data: { recordings: [] } }), null);
  assert.equal(recordingsMetaTotal({ data: { meta: {} } }), null);
  assert.equal(recordingsMetaTotal({ data: { meta: { total: null } } }), null);
  assert.equal(recordingsMetaTotal({ data: { meta: { total: -3 } } }), null);
  assert.equal(recordingsMetaTotal({ data: { meta: { total: "many" } } }), null);
  assert.equal(recordingsMetaTotal({}), null);
  assert.equal(recordingsMetaTotal(undefined), null);
});

test("archive process and upload calls outlive the 20s default with a 10 minute timeout", () => {
  const page = read("pages/Video.jsx");
  const processFn = page.slice(page.indexOf("async function retryProcessing"), page.indexOf("async function confirmDelete"));
  assert.match(processFn, /adminApi\.post\(`\/recordings\/\$\{encodeURIComponent\(item\.id\)\}\/process`, \{\}, \{ timeout: 600000 \}\)/);
  const uploadFn = page.slice(page.indexOf("async function uploadDraft"), page.indexOf("async function repostRepaired"));
  assert.match(uploadFn, /\/upload`, \{[\s\S]*?\}, \{ timeout: 600000 \}\)/);
  // While either call is pending, the page shows the existing status line.
  assert.match(page, /busy\.startsWith\("process:"\) \|\| busy\.startsWith\("upload:"\)/);
  assert.match(page, /<div className="cover-batch-status" role="status">正在后台整理\/校验，可能需要较长时间…<\/div>/);
});

test("errorMessage maps axios failure codes to Chinese guidance before the raw message", () => {
  assert.equal(errorMessage({ code: "ECONNABORTED", message: "timeout of 20000ms exceeded" }), "请求超时，请稍后重试");
  assert.equal(errorMessage({ code: "ERR_NETWORK", message: "Network Error" }), "网络连接失败，请检查网络后重试");
  assert.equal(errorMessage({ code: "ECONNABORTED" }), "请求超时，请稍后重试");
  assert.equal(errorMessage({ code: "ERR_NETWORK" }), "网络连接失败，请检查网络后重试");
  // Server-provided fields keep the highest priority over the code mapping.
  assert.equal(errorMessage({ code: "ERR_NETWORK", response: { data: { error: "余额不足" } } }), "余额不足");
  assert.equal(errorMessage({ code: "ECONNABORTED", response: { data: { message: "服务端提示" } } }), "服务端提示");
  // Unmapped codes and ordinary errors keep the previous behaviour.
  assert.equal(errorMessage({ code: "ERR_BAD_REQUEST", message: "Request failed with status code 400" }), "Request failed with status code 400");
  assert.equal(errorMessage({}), "请求失败，请稍后重试");
  assert.equal(errorMessage(null, "归档列表获取失败"), "归档列表获取失败");
});
