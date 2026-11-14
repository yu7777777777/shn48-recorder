import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins the "slow is not frozen" affordance added after visitors read the public
// live list spinner ("正在发现直播…") as a hung page. The list request can take
// longer than a normal page load whenever Pocket48 is slow, and a bare spinner
// carries no evidence that anything is still happening.
//
// These assertions are source-level on purpose: the component has no DOM test
// runner here (no jsdom, no Chromium), and the regression that matters is a call
// site silently reverting to the timeless `<LoadingState text="…" />` form.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

test("LoadingState stays a timeless spinner by default", () => {
  const source = read("src", "components", "LoadingState.jsx");
  // No slowText means the elapsed timer never starts and no markup changes.
  assert.match(source, /slowText = ""/);
  assert.match(source, /if \(!slowText\) return undefined;/);
});

test("LoadingState reports elapsed seconds and can offer a retry", () => {
  const source = read("src", "components", "LoadingState.jsx");
  // Assert the behaviour, not one literal spelling: the copy moved behind a
  // language table, and pinning the exact JSX text would block translation.
  assert.match(source, /copy\.waited\(Math\.round\(elapsed \/ 1000\)\)/);
  assert.match(source, /waited: \(seconds\) => `已等待 \$\{seconds\} 秒`/);
  assert.match(source, /onRetry/);
  // A decorative timer must stop with the component, otherwise a page that
  // finishes loading keeps a stray interval alive forever.
  assert.match(source, /return \(\) => window\.clearInterval\(timer\);/);
});

test("the public live list shows a slow state instead of an indefinite spinner", () => {
  const source = read("src", "pages", "PublicLive.jsx");
  // The copy moved into a language table: assert the wiring, not one spelling.
  assert.match(source, /loadingSlow: "(?:正在发现直播，比平时慢一些…|Finding lives is taking longer than usual…)"/);
  assert.match(source, /text=\{t\.loading\}[\s\S]{0,200}?slowText=\{t\.loadingSlow\}/);
  assert.match(source, /slowAfterMs=\{5000\}/);
  assert.match(source, /onRetry=\{\(\) => loadLives\(\)\}/);
});

test("the public replay list shows a slow state instead of an indefinite spinner", () => {
  const source = read("src", "pages", "PublicReplay.jsx");
  assert.match(source, /preparingSlow: "[^"]+"/);
  assert.match(source, /text=\{t\.page\.preparing\}[\s\S]{0,200}?slowText=\{t\.page\.preparingSlow\}/);
  assert.match(source, /slowAfterMs=\{6000\}/);
  assert.match(source, /onRetry=\{\(\) =>[\s\S]{0,200}?loadReplays\(\{/);
});

test("the slow state has styles for the elapsed badge and hint", () => {
  const source = read("src", "App.css");
  for (const selector of [".state-card-slow", ".state-card-elapsed", ".state-card-slow-actions", ".state-card-hint"]) {
    assert.ok(source.includes(selector), `missing ${selector}`);
  }
});

test("the public live page performs a non-quiet load on mount", () => {
  // The regression this pins: `loading` starts true and only `loadLives(false)`
  // clears it, but the polling loop calls `loadLives(true)`. Without a mount-time
  // non-quiet load the list spinner stayed on screen forever even after a 200
  // response, and the page only recovered when the visitor pressed 刷新.
  const source = read("src", "pages", "PublicLive.jsx");
  assert.match(source, /useEffect\(\(\) => \{\s*void loadLives\(\);\s*\}, \[loadLives\]\)/);
  // The polling loop must stay quiet, otherwise every 30s tick would flash the
  // full loading state over an already-rendered list.
  assert.match(source, /usePolling\(\(\) => loadLives\(true\), 30000\)/);
  // Guards against the quiet/non-quiet contract being inverted.
  assert.match(source, /if \(!quiet\) setLoading\(false\);/);
});
