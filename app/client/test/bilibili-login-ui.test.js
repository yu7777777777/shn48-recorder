import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins four interaction fixes with static source assertions: the Bilibili QR
// login must call the routes that actually exist server-side and stop polling
// on its own, the admin login must honour a safe ?redirect= after the 401 hard
// navigation loses location.state, stop-recording must confirm, and the
// auto-record roster must show a retryable failure instead of an empty state.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, "..", "src", file), "utf8");

test("bilibili page talks to the real qrcode routes and stops polling on its own", () => {
  const page = read("pages/Bilibili.jsx");
  // Server contract: GET /bilibili/qrcode issues key+PNG, /qrcode/check?key= polls it.
  assert.match(page, /adminApi\.get\("\/bilibili\/qrcode"\)/);
  assert.match(page, /adminApi\.get\("\/bilibili\/qrcode\/check", \{ params: \{ key \} \}\)/);
  assert.doesNotMatch(page, /\/bilibili\/login\/qrcode\//);
  assert.match(page, /data\.qrcodeKey \|\| data\.qrcode_key/);
  // Success reads authenticated/code; expiry stops the loop.
  assert.match(page, /data\.authenticated === true \|\| code === 0/);
  assert.match(page, /86038/);
  assert.match(page, /86090/);
  // The poll interval lives in a ref and is cleared on unmount.
  assert.match(page, /const qrPollRef = useRef\(null\)/);
  assert.match(page, /clearInterval\(qrPollRef\.current\)/);
  assert.match(page, /useEffect\(\(\) => \(\) => stopQrPolling\(\), \[\]\)/);
  // Five consecutive failed checks stop the loop with a visible message.
  assert.match(page, /failures >= 5/);
  assert.match(page, /二维码状态检查失败，请重新获取/);
});

test("bilibili account health badges never leak the English enum", () => {
  const page = read("pages/Bilibili.jsx");
  assert.match(page, /credentials_error: "凭据失效"/);
  assert.match(page, /unverified: "待核验"/);
  assert.match(page, /unavailable: "暂时无法验证"/);
  assert.match(page, /invalid: "凭据无效"/);
  assert.match(page, /healthy: "账号正常"/);
  assert.match(page, /offline: "未绑定 \/ 离线"/);
  assert.match(page, /healthText\[account\.health\] \|\| account\.health/);
});

test("bilibili upload queue failures surface an admin alert instead of staying silent", () => {
  const page = read("pages/Bilibili.jsx");
  assert.match(page, /const \[queueError, setQueueError\] = useState\(""\)/);
  assert.match(page, /setQueueError\(errorMessage\(results\[1\]\.reason, "上传队列获取失败"\)\)/);
  assert.match(page, /setQueueError\(""\)/);
  assert.match(page, /\{queueError && \(/);
  assert.match(page, /className="admin-alert error" role="alert"/);
});

test("admin login prefers a same-origin ?redirect= over location.state", () => {
  const page = read("pages/AdminLogin.jsx");
  assert.match(page, /useSearchParams/);
  assert.match(page, /searchParams\.get\("redirect"\)/);
  // Open-redirect guard: single leading slash, no protocol-relative or
  // absolute URL forms.
  assert.match(
    page,
    /redirect\.startsWith\("\/"\) && !redirect\.startsWith\("\/\/"\) && !redirect\.includes\(":\/\/"\)/
  );
  // The param wins over state.from, which a hard 401 navigation always loses.
  assert.match(
    page,
    /redirectSafe\s*\?\s*redirect\s*:\s*location\.state\?\.from\?\.startsWith\("\/admin"\)/
  );
  assert.match(page, /: "\/admin\/overview"/);
});

test("live page confirms stop-recording through ConfirmModal and keeps failed lists visible", () => {
  const page = read("pages/Live.jsx");
  // The stop button only arms the target; the modal runs stopRecording.
  assert.match(page, /const \[stopTarget, setStopTarget\] = useState\(null\)/);
  assert.match(page, /onClick=\{\(\) => setStopTarget\(recording\)\}/);
  assert.match(page, /<ConfirmModal/);
  assert.match(page, /isOpen=\{Boolean\(stopTarget\)\}/);
  assert.match(page, /onConfirm=\{\(\) => stopRecording\(stopTarget\)\}/);
  assert.match(page, /停止后本场直播剩余部分不再录制，已录片段将转入归档合并/);
  // A failed live-list request keeps the last list and renders the alert bar.
  assert.match(page, /const \[listError, setListError\] = useState\(""\)/);
  assert.match(page, /setListError\(errorMessage\(liveResult\.reason, "直播列表获取失败"\)\)/);
  assert.match(page, /\{listError && \(/);
  assert.match(page, /className="admin-alert error" role="alert"/);
  assert.doesNotMatch(page, /setLives\(\[\]\)/);
});

test("auto-record separates roster failure from the empty result and guards modal dismissal", () => {
  const page = read("pages/AutoRecord.jsx");
  // memberState "error" gets its own branch before the filtered empty state.
  assert.match(page, /memberState === "error" \? \(/);
  assert.match(page, /title="成员名单加载失败"/);
  assert.match(page, /onClick=\{\(\) => load\(\{ announce: true \}\)\}/);
  assert.match(page, /<span>重试<\/span>/);
  // Backdrop click and Escape stand down while any login input is non-empty;
  // the explicit cancel button keeps calling closeLogin directly.
  assert.match(page, /const loginDirty =/);
  assert.match(page, /className="modal-backdrop" onClick=\{dismissLogin\}/);
  assert.match(page, /if \(event\.key === "Escape"\) dismissLogin\(\)/);
  assert.match(page, /onClick=\{closeLogin\}/);
});
