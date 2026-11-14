import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins the wiring of the member social account page. The page itself is
// exercised in a browser; these checks catch the failures that a rebuild could
// hide: a route that disappears, a nav entry that is not reachable, or the
// notes-only editor accidentally regaining account subtypes.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const read = (file) => readFileSync(path.join(src, file), "utf8");

test("the social account route is lazy-loaded and mounted under the admin guard", () => {
  const app = read("App.jsx");
  assert.match(app, /lazy\(\(\) => import\("\.\/pages\/SocialAccounts"\)\)/);
  assert.match(app, /<Route path="social" element=\{<SocialAccountsPage \/>\} \/>/);
  // The route must sit inside the AuthGuard subtree, not next to the public pages.
  const guarded = app.slice(app.indexOf("<AuthGuard"));
  assert.ok(guarded.includes('path="social"'), "social route must stay behind AuthGuard");
});

test("the sidebar exposes the page in the 内容工具 section", () => {
  const layout = read("components/AdminLayout.jsx");
  assert.match(layout, /path: "\/admin\/social", label: "成员社交账号", icon: IconUsers/);
  const sections = layout.slice(layout.indexOf("const NAV_SECTIONS"));
  const tools = sections.match(/\{ label: "内容工具", from: (\d+), to: (\d+) \}/);
  assert.ok(tools, "内容工具 section must exist");
  const items = [...layout.slice(layout.indexOf("const navItems"), layout.indexOf("// Sidebar sections")).matchAll(/path: "([^"]+)"/g)].map((m) => m[1]);
  const index = items.indexOf("/admin/social");
  assert.ok(index >= Number(tools[1]) && index < Number(tools[2]), "成员社交账号 must be inside 内容工具");
});

test("account descriptions use notes without a dedicated Weibo subtype UI", () => {
  const page = read("pages/SocialAccounts.jsx");
  assert.ok(!page.includes("微博账号类型"));
  assert.ok(!page.includes('label="微博大号"'));
  assert.ok(!page.includes('label="微博小号"'));
  assert.ok(!page.includes("sizeLabel"));
  assert.ok(page.includes('size: ""'));
  assert.ok(page.includes("大号、小号、日常号或其他说明"));
  assert.ok(page.includes('${item.note || ""}'));
});

test("the page preserves social CRUD and reuses the existing Pocket48 roster", () => {
  const page = read("pages/SocialAccounts.jsx").replace(/\s+/g, " ");
  for (const endpoint of ['.get("/social")', 'adminApi.post("/social/accounts"', 'adminApi.put(`/social/accounts/', 'adminApi.delete(`/social/accounts/', 'adminApi.put(`/social/members/']) {
    assert.ok(page.includes(endpoint), `missing ${endpoint}`);
  }
  // Group rows carry a kind and optional join details.
  assert.match(page, /groupKind: draft\.platform === "group" \? draft\.groupKind : ""/);
  assert.match(page, /memberCount: draft\.platform === "group"/);
});

test("editor submits raw account input and provides native keyboard/error handling", () => {
  const page = read("pages/SocialAccounts.jsx");
  assert.ok(page.includes('adminApi.get("/pocket48/members")'));
  assert.ok(page.includes('Array.isArray(result?.list)'));
  assert.ok(page.includes('member.memberName'));
  assert.ok(page.includes('member.groupName'));
  assert.ok(page.includes('accountId: draft.accountId,'));
  assert.ok(!page.includes('new URL('), 'client must not extract or normalize profile URLs');
  assert.ok(page.includes('onSubmit={submit}'));
  assert.ok(page.includes('type="submit"'));
  assert.ok(page.includes('event.nativeEvent.isComposing'));
  assert.ok(page.includes('submitting.current'));
  assert.ok(page.includes('aria-invalid={Boolean(errors.accountId)}'));
  assert.ok(page.includes('Math.max(300, initial.note?.length || 0)'));
  assert.ok(page.includes('role="status"'));
  const css = read("pages/SocialAccounts.css");
  assert.ok(css.includes('100dvh'));
  assert.ok(css.includes(':focus-visible'));
});

test("nickname lookup stays advisory, debounced, accessible and separate from persistence", () => {
  const page = read("pages/SocialAccounts.jsx");
  assert.match(page, /adminApi\.post\("\/social\/lookup", \{ platform: current\.platform, accountId: current\.accountId \}\)/);
  assert.ok(page.includes('setTimeout(() => lookupName(), 650)'));
  assert.ok(page.includes('onBlur={() => lookupName()}'));
  assert.ok(page.includes('onCompositionStart='));
  assert.ok(page.includes('onCompositionEnd='));
  assert.ok(page.includes('current.platform === "group"'));
  assert.ok(page.includes('lookupRef.current.version === version'));
  assert.ok(page.includes('lookupRef.current.alive'));
  assert.ok(page.includes('nameSource.current !== "manual"'));
  assert.ok(page.includes('sa-lookup-retry'));
  assert.ok(page.includes('id="sa-lookup-status"'));
  assert.ok(page.includes('aria-live="polite"'));
  const lookupCode = page.slice(page.indexOf('async function lookupName'), page.indexOf('const memberOptions'));
  assert.ok(!lookupCode.includes('accountId: result'), 'only persistence may normalize the raw input');
  assert.ok(!lookupCode.includes('memberName:'), 'lookup must not change member association');
  assert.ok(!page.includes('next.accountName = "请'), 'lookup failure must not persist placeholder text');
});

test("compact member layout keeps existing CSS hooks and semantic cards", () => {
  const page = read("pages/SocialAccounts.jsx");
  for (const hook of ['sa-members', 'sa-member', 'sa-member-head', 'sa-member-actions', 'sa-cards', 'sa-card-title', 'sa-card-name', 'sa-card-actions']) {
    assert.ok(page.includes(`className="${hook}"`), `existing layout hook ${hook} must remain`);
  }
  assert.match(page, /<article\b/);
  assert.match(page, /<h2>\{group\.memberName\}<\/h2>/);
  assert.ok(!/minHeight|height:\s*\d{3}/.test(page), 'card compactness belongs to the stylesheet, not inline fixed heights');
});

test("directory uses equal columns, compact rows, truncated IDs and native action menus", () => {
  const page = read("pages/SocialAccounts.jsx");
  const css = read("pages/SocialAccounts.css");
  assert.ok(!page.includes("monogram("));
  assert.ok(!page.includes("sa-avatar"));
  assert.ok(!css.includes(".sa-avatar"));
  assert.ok(!css.includes("grid-column: span 2"), "member width must not depend on account count");
  assert.match(css, /\.sa-members\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sa-cards\s*\{[^}]*flex-direction: column/);
  const account = page.slice(page.indexOf("function AccountCard"), page.indexOf("function MemberView"));
  assert.ok(!account.includes("<footer"), "rows must not regain an empty footer action bar");
  assert.ok(account.includes('size={28}'));
  assert.ok(account.includes('href={account.profileUrl}'));
  assert.ok(account.includes('title={secondary}'));
  assert.match(css, /\.sa-account-secondary,[\s\S]*?text-overflow: ellipsis/);
  assert.ok(page.includes('<details className="sa-more"'));
  assert.ok(page.includes('<summary aria-label={label}'));
  assert.ok(page.includes('event.key === "Escape"'));
  assert.ok(page.includes('document.addEventListener("pointerdown", dismiss)'));
  assert.ok(page.includes('isOpen={pending?.mode === "remove"}'), "destructive actions still need confirmation");
});

test("no dead Weibo login helper remains reachable from the page or the server", () => {
  const page = read("pages/SocialAccounts.jsx");
  assert.ok(!page.includes("登录微博并读取"));
  const server = readFileSync(path.resolve(here, "../../server/index.js"), "utf8");
  // The old URL must fail loudly (404) instead of falling through to the SPA shell.
  assert.match(server, /app\.get\("\/weibo-session", \(_req, res\) => res\.status\(404\)/);
  assert.ok(!server.includes("pages/weibo-session"), "the helper module must not be required");
  assert.ok(!existsSync(path.resolve(here, "../../server/pages")), "the removed helper module directory must be gone");
});

test("every platform the API can return has a brand mark", () => {
  const icons = read("components/PlatformIcon.jsx");
  for (const platform of ["weibo", "xiaohongshu", "douyin", "bilibili", "group"]) {
    assert.ok(new RegExp(`\\b${platform}: \\{`).test(icons), `missing brand ${platform}`);
  }
});
