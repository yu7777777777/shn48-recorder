# UI 一致性整改规格（2026-10-15）

本文件是本次 UI 整改的**唯一权威规格**。所有子任务必须严格按此执行，不得自行发明令牌名或数值。

## 已锁定的设计决策

| 决策 | 结论 |
|---|---|
| 主按钮基调 | **保持近黑 `#0f172a` 不变**（P0-1 降级为不执行） |
| `--accent` 蓝紫定位 | **交互/定位色**（导航选中、焦点环、inset 标记、链接、选中态、spinner），**不是品牌主色**；与黑色主按钮分工共存 |
| 本轮范围 | P0 全部（P0-1 除外）+ P1 全部；P2 留待下轮 |

## 基线（改动前，已实测）

- `node scripts/version.mjs check` → `PASS version 1.17.8`
- `vite build` → 成功（4.21s）
- 测试：**54 通过 / 1 失败**；唯一失败 `pocket48-login-ui.test.js` 为预存行为缺陷（mock 401 后期望 `测试凭据无效` 可见，实际发生登录重定向），与 CSS 无关，**本轮不修、不视为回归**
- `dist/` 改动前 37 个文件哈希已存 `.tools/predist-hashes.txt`

## 本地工具链（重要）

本机无 Node/npm 于 PATH。使用 DSH 自带 Electron Node：

```powershell
$node = "$env:APPDATA\DSH Desktop\runtime-commands\generations\b2b2152845713c74678068d0a5db06ca31bfd93d60b2fa566d76bc23aa3b3732-7289101b-22e7-48ce-a776-ffbbe9effcdd\private\node-bin\node.cmd"
$env:CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
& $node --test "client/test/*.test.js"      # 于 app/ 下运行
& $node node_modules\vite\bin\vite.js build # 于 app/client 下运行
```

## 核心纠正：对比度数值

UI 设计师报告称 `--text-dim` 改为 `#7c8ba1` 可达 "≈4.6:1 通过 AA"。**经实测计算，该说法错误**：`#7c8ba1` 在白底仅 **3.46:1**，在面板底更低，**不通过 AA**。

经逐值实测，选定 **`#5e7089`**：

| 底色 | 对比度 | 判定 |
|---|---|---|
| `#ffffff`（白） | 5.05:1 | ✅ AA |
| `#f1f5f9`（`--bg-panel`） | 4.61:1 | ✅ AA |

必须选用 `#5e7089`，因为 `--text-dim` 实际用于 `.stat-label`、`th` 等**位于面板/卡片底**的元素。

## 一、要新增的令牌（全部加在 `index.css` 的 `:root` 内）

### 字号（P1-6）— 取现有最大公约数，不引入新数值

```css
--text-2xs: 10px;
--text-xs: 11px;
--text-sm: 12px;
--text-base: 13px;   /* 全站正文主力 */
--text-md: 14px;
--text-lg: 16px;
--text-xl: 20px;
--text-2xl: 24px;
--text-3xl: 28px;
```

### 字重（P1-7）

```css
--fw-regular: 400;
--fw-medium: 500;
--fw-semibold: 600;
--fw-bold: 700;
--fw-heavy: 800;
```

### 间距 4px 栅格（P1-8）

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
```

### 覆盖 `--text-dim`（P0-4）

```css
/* index.css 内，把 --text-dim: #94a3b8; 改为： */
--text-dim: #5e7089;
```

## 二、P0-2：补 `stat-card` 色调修饰符（`App.css`）

现状：`Dashboard.jsx:155/168/177`、`Video.jsx:340/358` 使用 `stat-card danger|success|accent`，但 `App.css` **无任何对应规则**（死类名）。补：

```css
.stat-card.danger  { border-color: var(--live-soft);    box-shadow: inset 0 3px 0 var(--live); }
.stat-card.success { border-color: var(--success-soft); box-shadow: inset 0 3px 0 var(--success); }
.stat-card.accent  { border-color: var(--accent-soft);  box-shadow: inset 0 3px 0 var(--accent); }
.stat-card.danger .stat-value  { color: var(--live); }
.stat-card.success .stat-value { color: var(--success); }
.stat-card.accent .stat-value  { color: var(--accent); }
```

同时**删除** `Dashboard.jsx` 中为补红色而写的内联 `style={{ color: ... }}`（若存在）。

## 三、P1-7：修正孤立字重（`App.css:1988`）

```css
/* 改前 */
.archive-record-title { ... font-weight: 750; ... }
/* 改后：750 不在 Google Fonts 加载列表(400;500;600;700;800)内，会触发 faux-bold 合成 */
.archive-record-title { ... font-weight: var(--fw-bold); /* 700 */ ... }
```

## 四、P0-3：消除竞争蓝紫副本

`Pocket48.css`、`AnalysisPanel.css` 是**半令牌化**文件：混用 `var(--text-secondary,#64748b)` 与硬编码蓝族。按下列映射**逐值替换**：

| 硬编码值 | 替换为 |
|---|---|
| `#315cf5`、`#2454e6`、`#214de1`、`#2563eb`、`#6683ed` | `var(--accent)` |
| `#edf2ff`、`#eaf0ff`、`#eaf2ff` | `var(--accent-soft)` |
| `#64748b`、`#7a889d`、`#71839d`、`#536784`、`#607493`、`#66758f` | `var(--text-muted)` |
| `#8793a6`、`#8b99ac` | `var(--text-dim)` |
| `#0f172a`、`#172b49`、`#24334c` | `var(--text-main)` |
| `#334155` | `var(--text-soft)` |
| `#dce5ef`、`#dce3ed`、`#dce4ee`、`#e3e9f2`、`#e4eaf2`、`#dce4f0`、`#dce5ff` | `var(--border)` |
| `#edf1f7`、`#e5eaf1`、`#edf0f5`、`#e5eaf2`、`#eef2f9` | `var(--border-soft)` |
| `#fafcff`、`#f6f8fc`、`#fff`、`white` | `var(--bg-surface)`（聊天列背景用 `var(--bg-panel)`） |

**例外（保留原值，不动）**：
- `.p48-bubble` 的 `border-radius: 3px 14px 14px 14px` — 刻意的不对称尾角，只把 `14px` 换成 `var(--radius-lg)`
- 通知列紫色气泡 `#f6f0fc` / `#e9ddf4` — 新增令牌 `--bubble-notify-bg` / `--bubble-notify-border` 存入 `:root`，值不变
- 错误红 `#b73535`、`#ac4545` — 归一到 `var(--danger)`
- 成功绿 `#16845d` → `var(--success)`
- `#50a599`（全员列）、`#b18bd3`（通知列）顶边色 — 新增 `--column-members` / `--column-notify` 令牌，值不变

## 五、P1-5：圆角收敛到既有 4 档令牌

映射（**不新增令牌**）：

| 裸值 | 替换 |
|---|---|
| `4px`、`5px`、`6px`、`7px`、`8px`、`9px` | `var(--radius-sm)` (6px) |
| `10px`、`12px` | `var(--radius)` (10px) |
| `14px`、`18px` | `var(--radius-lg)` (14px) |
| `20px`、`24px` | `var(--radius-xl)` (20px) |
| `99px`、`999px`、`9999px` | `var(--radius-full)` |

注意：`AnalysisPanel.css` 的 `.analysis-caption` 用 `12px` → `var(--radius)`；`.analysis-line-editor` 等保持结构。

## 六、P1-8：间距收敛（关键项，其余渐进）

**本轮只做能消除可见错位的保守收敛**：

| 位置 | 改前 | 改后 |
|---|---|---|
| `.card` padding（`App.css:1742`） | `20px 22px` | `var(--space-5) var(--space-5)` (20px 20px) |
| `.stat-card` padding（`App.css:1783`） | `18px 20px` | `var(--space-5) var(--space-5)` (20px 20px) |
| `.card` 同型 padding（`App.css:2186`） | `20px 22px` | `var(--space-5) var(--space-5)` |

目的：使 `.card` 与 `.stat-card` 的水平内边距一致（原 22 vs 20 产生 2px 错位）。

> 行号已实测核对：`App.css:1739` 为 `.card {`、`:1742` 为 `padding: 20px 22px`、`:1780` 为 `.stat-card {`、`:1783` 为 `padding: 18px 20px`。

> ⚠️ **编码陷阱**：本项目 CSS/JSX 均为**无 BOM 的 UTF-8**。PowerShell 的 `Get-Content` 默认编码会读出乱码（如 `密码安全强度` 显示为 `瀵嗙爜瀹夊叏寮哄害`），**这是读取端假象，文件本身无损坏**（已全量扫描：0 处替换字符）。读写文件必须显式使用 UTF-8，否则会把正常中文写成真乱码。改动用 `edit` 工具（按字面量替换）可规避此问题。

其余间距值**本轮不动**，留待下轮（28 值全量收敛风险过高）。

## 七、P1-9：内联样式治理（仅试点 `Security.jsx`）

在 `App.css` 末尾新增工具类：

```css
.row-between { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.row-center  { display: flex; align-items: center; gap: var(--space-2); }
.inset-panel { padding: var(--space-3) 14px; background: var(--bg-panel);
               border: 1px solid var(--border); border-radius: var(--radius); }
```

仅替换 `Security.jsx` 中**完全重复**的内联容器样式（`:292`、`:303` 等）。其余页面本轮不动。

## 八、P1-6 字号收敛（保守）

只做以下**语义明显错位**的收敛，其余不动：

| 位置 | 改前 | 改后 |
|---|---|---|
| `.analysis-heading h2`（`AnalysisPanel.css`） | `22px` | `var(--text-xl)` (20px) |
| `.audit-overview strong`（`ReplayAudit.css`） | `25px` | `var(--text-2xl)` (24px) |
| `.p48-conversation h2`（`Pocket48.css`） | `24px`/`17px` | `var(--text-2xl)` / `var(--text-lg)` |
| `.analysis-caption`（`AnalysisPanel.css`） | `17px` | `var(--text-lg)` (16px) |

**其余字号一律不动**——95 处 11/12/13px 的全量令牌化风险过高，留待下轮。

## 九、验收标准（必须逐条可验证）

1. `node scripts/version.mjs check` → PASS
2. `vite build` → 成功
3. 测试 → **54 通过 / 1 失败**（失败者仍为 `pocket48-login-ui.test.js`）
4. 静态断言（由审核方脚本校验）：
   - `App.css` 中 `font-weight: 750` 出现 **0** 次
   - `.stat-card.danger|success|accent` 规则存在，且 `App.css` 内 `.stat-card` 规则数 **≥ 5**
   - `App.css` 中裸 `border-radius: <数字>px` 出现 **0** 次
   - `Pocket48.css`、`AnalysisPanel.css` 中 `#315cf5`/`#2454e6`/`#214de1` 出现 **0** 次
   - `index.css` 中 `--text-dim: #5e7089`
   - `:root` 中新增令牌数 ≥ 25
5. `dist/` 可重新构建；`index.html` 引用完整

## 十、禁止事项

- **不得**把主按钮改为蓝色（决策已锁定为近黑）
- **不得**修改 `--accent` 的值
- **不得**改动 `index.css:1` 的字体加载列表
- **不得**引入新的 CSS 文件
- **不得**修改任何 `.test.js`
- **不得**改动 `Dashboard.jsx` 以外的非样式逻辑
