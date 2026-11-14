import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("toast provider memoizes the context value so consumers skip toast churn", async () => {
  const toast = await source("components/Toast.jsx");
  assert.match(toast, /import React, \{[^}]*useMemo[^}]*\} from "react"/);
  assert.match(
    toast,
    /const contextValue = useMemo\(\s*\(\) => \(\{ showToast, success, error, warning, info \}\),\s*\[showToast, success, error, warning, info\]\s*\)/
  );
  assert.match(toast, /<ToastContext\.Provider value=\{contextValue\}>/);
});

test("toast timers are tracked, reset on dedupe refresh and cancelled on close", async () => {
  const toast = await source("components/Toast.jsx");
  assert.match(toast, /const timers = useRef\(new Map\(\)\)/);
  // A dedupe hit on a live card reschedules its auto-dismiss.
  assert.match(toast, /scheduleRemoval\(live\.id, live\.duration\)/);
  // Manual close cancels the pending timer instead of leaving it behind.
  const removeToast = toast.slice(toast.indexOf("const removeToast"), toast.indexOf("const scheduleRemoval"));
  assert.match(removeToast, /clearTimeout\(pending\)/);
  assert.match(removeToast, /timers\.current\.delete\(id\)/);
  assert.match(removeToast, /filter\(\(t\) => t\.id !== id\)/);
});

test("dedupe hit refreshes a live card but restacks when the previous card is gone", async () => {
  const toast = await source("components/Toast.jsx");
  const helper = toast.slice(
    toast.indexOf("function findDedupeTarget("),
    toast.indexOf("const ToastContext = createContext")
  );
  assert.ok(helper.includes("findDedupeTarget"), "dedupe target helper must exist in Toast.jsx");
  const findDedupeTarget = vm.runInNewContext(`${helper}\nfindDedupeTarget`);
  const card = { id: "a1", message: "boom", type: "error", repeats: 2, duration: 4500, at: 1 };
  // Card still on screen: the hit refreshes that exact card.
  assert.equal(findDedupeTarget([card], { message: "boom", at: 2, repeats: 2, id: "a1" }), card);
  // Card already auto-dismissed, closed or evicted: the hit must restack.
  const other = { id: "b2", message: "boom", type: "error", repeats: 3, duration: 4500, at: 1 };
  assert.equal(findDedupeTarget([other], { message: "boom", at: 2, repeats: 3, id: "a1" }), undefined);
  assert.equal(findDedupeTarget([], { message: "boom", at: 2, repeats: 3, id: "a1" }), undefined);
  // Keys recorded without a card id always restack.
  assert.equal(findDedupeTarget([card], { message: "boom", at: 2 }), undefined);
  assert.equal(findDedupeTarget([card], null), undefined);
});

test("config page loads settings once instead of on every toast churn", async () => {
  const config = await source("pages/Config.jsx");
  const initEffect = config.slice(config.indexOf("useEffect("), config.indexOf("function setValue"));
  assert.match(initEffect, /Promise\.allSettled/);
  assert.match(initEffect, /\}, \[\]\);/);
  assert.doesNotMatch(initEffect, /\[toast\]/);
});

test("replay audit fetch effects no longer depend on the toast object", async () => {
  const page = await source("pages/ReplayAudit.jsx");
  assert.doesNotMatch(page, /\[importOpen,\s*toast\]/);
  assert.doesNotMatch(page, /\[importForm\.memberId,\s*toast\]/);
  assert.match(page, /\},\s*\[importOpen\]\s*\)/);
  assert.match(page, /\},\s*\[importForm\.memberId\]\s*\)/);
});
