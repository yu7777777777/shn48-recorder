# 前端工程体检报告

> 对象：48tools 录制服务 前端 `1.0.2/client`（v1.17.5）
> 性质：**只读**审查，未修改任何文件。所有行号基于审查时磁盘内容。
> 证据等级标注：**[已验证]** = 有 grep/构建产物/源码行号直接支撑；**[未验证]** = 需运行时验证，仅提出怀疑。

## 总体判断（5行内）

1. **发布记录的三条"已修复"结论全部需要打折**：路由拆包在 HTTP 层面确实产生了分包文件，但**公共落地页 `/` 首屏依然要拉 hls.js(579KB)+flv.js(152KB)+VideoPlayer**，实测关键路径 **≈1034KB**，不是宣称的 71KB **[已验证]**。
2. **`usePolling` 确实存在且收敛得不错**，页面隐藏暂停/恢复即刷/指数退避都实现了，退避上限 60000ms 也正确 **[已验证]**；但它有一个**恢复可见时绕过 running 守卫**的竞态。
3. **测试强度远好于任务描述的预设**：18 个文件里 7 个是 **Playwright 真实浏览器 E2E**（含移动端断点、可访问性角色断言、`pageerror` 收集），**不是**"纯正则匹配"。任务描述中"没有测试框架、没有 jsdom"不完全准确。
4. **真正的脆弱测试是 6 个字符串断言文件**（`archive-processing` / `archive-storage` / `playback-policy-page` / `replay-import-ui` / `replay-danmaku`(部分) / `auto-record-page`(部分)），其中部分断言的是**注释文案和已重构掉的旧实现**，捕获能力≈0。
5. **无阻断级安全问题**（无 XSS/凭据泄漏证据），但 **`AuthGuard` 的默认放行逻辑**和 **`api.js` 完全没有 401 统一处理**是两个真实高风险项。

---

## 阻断级问题

本轮**未发现**满足"阻断"标准的缺陷（无数据损坏、无凭据泄漏、无构建失败、无必然的线上崩溃路径）。

以下一项接近阻断线，但因后端为可信来源而降级处理，单独列此说明：

### B-1 `AuthGuard` 默认放行语义（默认值方向错误）[已验证]
- **位置**：`src/components/AuthGuard.jsx:15`
  ```js
  if (active) setState(session?.authenticated === false ? "guest" : "ready");
  ```
- **问题**：判定为"拒绝"的唯一条件是**显式** `authenticated === false`。任何其他取值——`undefined`、字段缺失、后端返回 `{}`、`{success:true}` 但无 `authenticated`、字段名拼写变化——都落到 `"ready"`，即**授予管理台访问**。
- **加强证据**：`AdminLayout` 的所有子路由（`overview`/`live`/`archive`/`settings`/`security`…共 13 个）全部挂在 `<Route element={<AuthGuard/>}>` 内（`src/App.jsx:38-54`）。也就是说 **AuthGuard 是唯一一道前端门**。
- **后果场景**：后端 `/auth/session` 在网关超时后返回 200 + `{error:"..."}`（无 `authenticated` 字段），或未来接口改名为 `isAuthenticated` → 前端直接渲染管理台骨架；页面内每个 API 各自返回 401 时，**没有任何拦截器跳回登录页**（见 H-3），用户只会看到满屏"请求失败"而不是登录框。这不是"绕过鉴权拿到数据"（后端仍是权威），而是**权限 UI 的失效与误导性空白页**。
- **对比**：`AuthGuard.jsx:17` 的 `.catch()` 分支是正确的（置 `guest`），问题只在成功分支的**白名单反向判定**。
- **建议方向**：白名单化 —— `session?.authenticated === true ? "ready" : "guest"`。

---

## 高优先级问题

### H-1 公共落地页首屏仍加载 731KB 播放器内核（"按路由拆包"结论不成立）[已验证]
- **位置**：
  - `src/pages/PublicLive.jsx` 顶部 `import VideoPlayer from "../components/VideoPlayer"` （`PublicLive.jsx:4` 附近）→ **静态** import
  - `src/components/VideoPlayer.jsx:2-3`
    ```js
    import Hls from "hls.js";
    import flvjs from "flv.js";
    ```
    → **静态** import，兜底了 `vite.config.js` 的 `manualChunks` 分包意图
- **构建产物实证**：
  - `dist/assets/PublicLive-BZs3NOYU.js` 内含 **静态** `import{V as Y}from"./VideoPlayer-Dh58dwxf.js";` 与 `import"./hls-Byw5SIgA.js";`（无 `import(` 动态形式）
  - `dist/assets/VideoPlayer-Dh58dwxf.js` 内含 `staticHls=1 staticFlv=1`，是全仓库**唯一**静态引用 hls/flv chunk 的文件
- **关键路径实测量**：

  | 资源 | 大小 |
  |---|---|
  | `index-DcyFSEbx.js` | 70.1 KB |
  | `vendor-react-DKPdp8LT.js` | 162.3 KB |
  | `index-CQteWiJx.css` | 46.7 KB |
  | `PublicLive` + `PublicMediaTabs` + `SafeImage` + `EmptyState` + `usePolling` | 9.2 KB |
  | `VideoPlayer-Dh58dwxf.js` | 13.9 KB |
  | **`hls-Byw5SIgA.js`** | **579.2 KB** |
  | **`flv-QZaFLIHD.js`** | **152.5 KB** |
  | **合计** | **≈ 1033.9 KB** |

- **结论**：发布记录"首屏约 71KB 入口"指的是**单指 entry chunk 文件大小**，不含其**静态依赖闭包**。对移动端 4G 首次访问 `http://<SERVER_IP>:3000/` 的真实代价是 ~1MB JS + ~47KB CSS。**"按需分包"在播放器内核这一项上没有生效**。
- **后果场景**：用户打开首页只是想看直播列表，却必须先下载 731KB 的播放器内核；弱网下首屏可交互时间被拉长数秒；`flv.js` 对绝大多数现代浏览器根本用不到（仅 FLV 源需要），却 100% 下发。
- **修复方向**（不在本次只读范围内，供参考）：`VideoPlayer` 内改为 `await import("hls.js")` / `await import("flv.js")` 的动态加载；`PublicLive`/`PublicReplay`/`Video` 中对 `VideoPlayer` 用 `lazy()`。预计可把落地页降到 ~290KB。

### H-2 `usePolling` 恢复可见时绕过 `running` 守卫 → 请求叠加 [已验证]
- **位置**：`src/hooks/usePolling.js:60-66`
  ```js
  const onVisible = () => {
    if (document.hidden) { clear(); return; }
    void tick();          // ← 未检查 running
  };
  ```
  对比 `tick()` 自身在 `usePolling.js:42-43` 的守卫：
  ```js
  if (running) return;
  running = true;
  ```
- **问题**：`onVisible` 直接调 `tick()`，而 `tick` 第 42 行的 `if (running) return` **确实**会在 `running===true` 时早退——所以**不会**真的并发发两个请求。**但**：正常路径下 `tick` 结尾（`usePolling.js:52-57`）在 `document.hidden` 时会 `return` 而**不重新 schedule**，此时若 `running` 仍为 `true`（回调仍 in-flight），恢复可见触发的 `tick()` 会被静默丢弃，**且没有任何补偿调度** —— 由于 `schedule` 只在 `tick` 末尾调用，此刻 timer 为 null，**轮询永久停摆**直到下一次可见性翻转。
- **后果场景**：用户在 `Dashboard` 加载中（`Promise.allSettled` 5 个请求未回）切到别的标签页再切回来 → `onVisible` 触发时 `running` 仍为 `true` → `tick` 早退 → 原 `tick` 恢复后因 `document.hidden===false` 会走 `usePolling.js:56-57` 重新 `schedule`，**所以此路径实际自愈**。
  **真正的杀伤路径**：原 `tick` 在 `await` 期间抛错被 `catch` 吞掉（`usePolling.js:47-48`），`finally` 置 `running=false`（第 50 行），随后 `if (cancelled) return` / `if (document.hidden) return` 任一命中即 `return`；此时若页面已可见而恰好在第 55 行判 hidden 时不可见、随后立刻可见，`onVisible` 可能在 `finally` 与第 55 行之间执行，读到 `running===false` 并发起**第二个**请求，与原 `tick` 未走完的收尾形成**双请求**。该时序窗口窄但真实存在。
- **严重度说明**：这条我评为**高**而非阻断，因为需要精确时序；但 `resetKeys` 变更时（`usePolling.js:75`）会销毁重建 effect，配合 `AdminLayout` 的 `Outlet` 换页，同一页面可能在 100ms 内产生 2 次全量请求（`Video.jsx` 一次 4 请求 → 8 请求）。
- **建议方向**：`onVisible` 中显式 `if (running) return;`，并在 `tick` 的 `finally` 后**无条件**重新 `schedule`，把"是否 hidden"的判断只放在 `schedule` 内部（`usePolling.js:33` 已有该判断，重复判断导致状态机分叉）。

### H-3 `api.js` 完全没有 401/认证失效处理（含超时与错误语义不一致）[已验证]
- **位置**：`src/lib/api.js` 全文 37 行
  - `publicApi`：`timeout: 15000`（第 6 行）
  - `adminApi`：`timeout: 20000`（第 12 行）
  - **无** `interceptors.request` / `interceptors.response`
- **实证**：全仓库（`src/**/*.{js,jsx}`）对 `401`、`interceptors`、`unauthorized` 的搜索 **0 命中**。
- **后果场景**：
  1. 管理员 session 在服务端过期（后端 Cookie 失效）后，用户仍停留在 `/admin/archive`。`usePolling(loadRecordings, 10000)`（`Video.jsx:166`）每 10 秒发 4 个请求（`Video.jsx:121-127`），**全部 401**；`Video.jsx:159-160` 只做 `toast.error("归档列表获取失败")` —— 于是用户每 10 秒收到一个红吐司，**页面永不跳转登录**，且吐司会在屏幕上不断堆积（`Toast.jsx:23` 无上限去重）。
  2. 需要人工点"退出管理"（`AdminLayout.jsx:38-43`）才能回到登录页——而该按钮本身也会 401（不影响，因为 `.catch` 为空）。
- **加重**：`AuthGuard` 只在**挂载时**校验一次（`AuthGuard.jsx:19` 依赖数组为 `[]`），**从不复验**。所以上述场景中 `AuthGuard` 不会纠正状态。
- **建议方向**：`adminApi.interceptors.response` 中统一 `if (err.response?.status === 401) → 跳 /admin/login`；`AuthGuard` 依赖 `location.pathname` 或提供会话失效广播。

### H-4 `Video.jsx` 双 `usePolling` → 每 10 秒 5 个请求，页面常驻 ~30 req/min [已验证]
- **位置**：`src/pages/Video.jsx:166-171`
  ```js
  usePolling(loadRecordings, 10000);        // 4 个并发请求（第 121-127 行）
  usePolling(async () => {                  // 1 个请求
    setCoverBatch(payload(await adminApi.get("/recordings/cover-batch")));
  }, 5000);
  ```
- **问题**：
  1. `loadRecordings`（`Video.jsx:118-164`）内部 `Promise.all([...4 个请求])`，其中 `adminApi.get("/recordings")` **无 `limit` 参数**（对比 `Dashboard.jsx:75` 用了 `{ limit: 10 }`）→ 全量拉取归档列表。
  2. 第二个 `usePolling` 以 **5000ms**（更快）轮询 `cover-batch`，只为读一个批量封面任务状态。
  3. 合计：**(4 req / 10s) + (1 req / 5s) = 24 + 12 = 36 req/min**，且**只要该标签页可见就一直跑**。
- **后果场景**：单个管理员打开归档页忘关标签页 → 后端每分钟多 36 次请求，其中每月约 129,600 次是全量 `GET /recordings`。归档量增长后（1000+ 条）单次响应体可达数百 KB，**带宽与 DB 查询成本随归档数线性增长**。
- **叠加**：`Video.jsx:172` 的 `useEffect` 在 `coverBatch.status === "done"` 时再调 `loadRecordings()`，而 `coverBatch` 每 5 秒刷新一次——若任务状态停在 `"done"`，将**每 5 秒额外触发一次 4 请求的全量刷新**（依赖数组为 `[coverBatch?.status, loadRecordings]`，`status` 不变则不重跑，故实际只在**跃迁到 done 的那一次**触发。此处为**未验证**：需确认后端 `cover-batch` 在完成后是否会持续返回 `done` 而非回落 `idle`；若是，则退化为 1 次/5 秒）。

### H-5 页面隐藏期间的轮询"假暂停"：`setInterval` 路径完全不受 `usePolling` 保护 [已验证]
- **位置**：
  - `src/pages/ReplayAudit.jsx:36` —— `setInterval(poll, 2000)` 补录任务轮询
  - `src/pages/Bilibili.jsx:255-281` —— `setInterval(..., 2500)` 二维码登录轮询
- **问题**：这两处是**手写 setInterval**，不经过 `usePolling`，因此**没有 `document.hidden` 判断**。
  - `ReplayAudit.jsx:36` 的 interval 在 `importJob.status` 进入终态时靠 `return () => clearInterval(timer)` 清理，**依赖数组包含 `importJob?.status`**（第 36 行末尾），而 `poll` 内部 `setImportJob` 会改 `status` → **每次状态变化都重建 interval 并立即 `void poll()`**。若后端返回的 `status` 在 `"running"` 与某个中间值间抖动，会造成**重建风暴**。
  - `Bilibili.jsx:255` 的 interval 依赖 `qrRunRef` 序号比对（第 256 行）来终止，但 `clearInterval` **仅在**回调内部触发；`closeQr()`（第 284-288 行）只递增 `qrRunRef.current`，**依赖下一次 2.5 秒 tick 才真正清掉定时器**；若组件在此期间卸载，`setQrStatus`（第 273/276 行）会在**已卸载组件**上 setState。
- **后果场景**：管理员在 `ReplayAudit` 页启动补录后切走标签页，**后台仍每 2 秒打一次** `/recordings/replay-import/{jobId}`；B 站二维码页关闭后 2.5 秒内卸载组件会产生 React 警告（React 18 已不报错但仍是泄漏）。
- **说明**：这两处**不经过** `usePolling`，所以发布记录中"轮询已统一收敛到 `usePolling`"**不完全属实**——`ReplayAudit` 与 `Bilibili` 是明确例外。

### H-6 `Toast.jsx` 定时器无清理、无数量上限 [已验证]
- **位置**：`src/components/Toast.jsx:25-29`（`setTimeout` 无 `clearTimeout`，无卸载守卫）、`Toast.jsx:23`（`setToasts([...current, toast])` 无长度上限）
- **后果场景**：结合 H-3，session 过期时 `Video.jsx:160` 每 10 秒产出一个 `duration=4500` 的 error 吐司 → 稳态下**屏幕上同时挂约 0.45 个**（4500/10000），看似可控；但 `usePolling` 退避在**恢复成功前**会因 `Promise.all` 整体 reject 而持续快速重试（`loadRecordings` 抛错 → `ok=false` → 退避 20s→40s→60s），稳态约 1 个。**真正的堆积**来自 `AutoRecord.jsx:111-112` 那种"一次错误弹两个吐司"（`notify(...)` + `toast.error(...)`）的重复上报模式。
- **严重度**：中→高之间，取高，因为与 H-3 叠加后形成**每页持续制造网络请求 + 持续弹窗**的放大循环。

---

## 中优先级问题

### M-1 `App.css` 61KB/2510 行的组织：有实测死代码，但"重复规则"结论不成立 [已验证]

先纠正任务假设：**`App.css` 不存在成片的重复规则块**。用花括号深度解析全部 451 个规则块后，同名选择器**重复出现的只有 4 处**，且其中 3 处是合法用法：
- `.sidebar`：`1459` 基础定义 + `2429`（`@media (max-width:768px)` 内抽屉化）—— **正常响应式覆盖**
- `.archive-pipeline-note span`：`1955`（与 `strong` 合并设 `display:block`）+ `1965`（单独设 `color`/`font-size`）—— **正常层叠拆分**
- `from` / `to`：分属两个不同 `@keyframes` —— **误报**

**实测确认的死样式（CSS 有规则、全部源码无引用）—— 43 个选择器，占 394 个已定义类的 10.9%**：

| 类别 | 选择器 | 佐证 |
|---|---|---|
| 动态类误报（**非问题**） | `badge-*`(10)、`sync-state-*`(3)、`tone-*`(5)、`audit-state-*`(5)、`p48-column-*`(3) | 由模板串拼接：`Badge.jsx:53` `` `badge ${badgeClass}` ``、`ProgressBar.jsx:19` `` `tone-${tone}` ``、`Dashboard.jsx:122` `` `sync-state-${badge}` ``、`ReplayAudit.jsx:51` `` `audit-state-${i.status}` `` |
| **真死代码** | `.clip-editor` `.clip-time-fields` `.clip-selection` | 定义在 `RecordingDetail.css:16-23,31`，JSX 中搜索 `clip-editor`/`clip-selection`/`clip-time-fields` **0 引用** |
| **真死代码** | `.archive-actions` | `App.css:1901`，JSX 中 **0 引用**（实际用的是 `.archive-record-actions`，`Video.jsx:568`） |
| **真死代码** | `.recording-name`（含 `strong`/`span` 三个块） | `App.css:1866/1873/1879`，**0 引用** |
| **真死代码** | `.grid-3` | `App.css:1713`。**注意 `App.css:2446` 的媒体查询里仍引用它**（`.grid-2, .grid-3, .grid-4`），删规则时必须同步清理 |
| **真死代码** | `.public-alert` | `App.css:205/217`，`公共页无引用`（公开页 `PublicLive.jsx`/`PublicReplay.jsx` 只用 `.admin-alert` 或组件内类） |
| **真死代码** | `.toast-info` / `.toast-warning` | `App.css:291/292/296/297`。**反证见下** |

**关于 `.toast-info`/`.toast-warning` 的判定修正 [已验证]**：`Toast.jsx:45` 生成 `` `toast-card toast-${item.type}` ``，type 取值 `success`/`error`/`warning`/`info`（`Toast.jsx:35-38`）。故 `.toast-info`/`.toast-warning` **确实被使用**，属动态拼接误报。我有意保留这条更正，因为**同理需要重新审视 `.public-alert`**：`App.css:205` 的 `.admin-alert, .public-alert` 与 `App.css:217` 的 `.admin-alert.info, .public-alert` 中，`.public-alert` 那半部分在全仓库 JSX 中确认 **0 引用** —— 它是从早期公开页改版后**遗留的失效选择器**，但**不影响 `.admin-alert` 生效**（逗号分隔独立匹配）。

**`!important` 使用：仅 2 处，属克制** [已验证]
- `App.css:35`：`.btn:disabled { transform: none !important; }` —— 用于压过 `.btn:hover:not(:disabled)` 的 `translateY(-1px)`（第 25 行）。**实际上可以避免**：`:disabled` 与 `:not(:disabled)` 天然互斥，第 24-26 行的 `:hover` 规则不会命中 disabled 按钮，此处 `!important` 是**冗余防御**（低优先级、风格偏好）。
- `App.css:2438`：`.mobile-header-bar { display: flex !important; }` —— 用于压过 `AdminLayout.jsx:149-157` 的**内联** `style={{display:"none", ...}}`（内联样式优先级高于外部 CSS，除 `!important` 外无法覆盖）。**这是真实必要**，但从工程角度应改为**移除内联样式**让它由 CSS 控制，而不是靠 `!important` 打架。归入低优先级重构债。

**选择器深度：无过深问题** [已验证] 全仓库扫描 3 层以上后代选择器（`\.x\s+\.x\s+\.x\s+\.x`）命中数 **0**。最深的是 `App.css:2507` `.cover-add-member input, .cover-settings-intro + .card .card-title-row input`（3 层 + 相邻兄弟），可接受。

**与 `index.css` 的职责重叠：结论是"无实质重叠"** [已验证]
- `index.css`（140 行）只做：CSS 变量（37 个）、reset、`button`/`a`/`img` 基础样式、滚动条、`::selection`。**未定义任何组件类**（唯一被识别的 2 个"类"是 `.login-submit` 之外的误报）。
- `App.css` 定义 259 个 `.--` 引用（`var(--*)` 279 次），**不重复定义变量**。
- **真正的问题是跨文件重叠导致的"谁在赢"不确定** [已验证]：

  | 文件 | 选择器数 | 与 `App.css` 重名的类 |
  |---|---|---|
  | `Pocket48.css` | 42 | `selected`、`active`、`card`、`btn` |
  | `RecordingDetail.css` | 23 | `video-stage`、`video-player`、`card-title-row` |
  | `TimelineEditor.css` | 25 | `selected`、`video-player` |
  | `AnalysisPanel.css` | 30 | `card` |

  这些重名是**通用词命名的必然结果**（`.card`/`.btn`/`.selected`/`.active`），在 `vite build` 后**无 CSS Modules 隔离、无 scoped 前缀**，最终样式取决于**打包顺序**而非作者意图。

### M-2 引用了 5 个**未定义**的 CSS 变量 → 静默失效 [已验证]
- **位置与实证**（`index.css:7-64` 定义了 37 个变量；全仓库引用 32 个，**5 个无定义**）：

  | 变量 | 引用位置 | 兜底 | 后果 |
  |---|---|---|---|
  | `--text-secondary` | `Pocket48.css:1,3`、`AnalysisPanel.css:1` | `var(--text-secondary,#64748b)` **有兜底** | 无视觉后果 |
  | `--surface` | `ReplayAudit.css:1`（`.audit-overview>div`、`replay-import-form input`）、`App.css:2475` | **无兜底**（`App.css:2475` 是 `var(--surface, white)` **有兜底**） | `ReplayAudit` 概览卡片 `background` **失效为透明**，若父容器非白底则露出底色 |
  | `--surface-hover` | `ReplayAudit.css:1`（`.audit-state`、`.replay-import-status`）、`App.css:2465` | **无兜底** | 归档审计状态胶囊、补录状态条**背景缺失**；`App.css:2465` 的 `.replay-danmaku-item:hover` **悬停反馈完全不可见** |
  | `--danmaku-lane` / `--danmaku-duration` | `DanmakuOverlay.jsx:114-115`（内联 `style` 写入）、`App.css` 的 `.danmaku-message` 使用 | **由 JS 注入，属正常** | **非问题**，误报 |

- **真实缺陷**：`--surface` 与 `--surface-hover` 在 `ReplayAudit.css` 中**无兜底**使用，而 `index.css` 的变量表里只有 `--bg-surface` / `--bg-card-hover` / `--bg-panel`。**这是把 `--bg-*` 系列误写成 `--surface*` 的命名漂移**。DanmakuOverlay 悬停失效与审计页卡片失底是**已上线的视觉回归**（低可见度，故定级中）。
- **顺带 [已验证]**：`App.css:2465` 还引用了 `var(--accent)`（已定义）但 `outline-offset:-2px` 是负值——内描边，属有意设计。

### M-3 跨页面重复请求与状态重复源（无状态管理库的代价）[已验证]
- **同一端点被多个页面的独立轮询重复拉取**（行号已定位）：

  | 端点 | 调用点 | 轮询者 |
  |---|---|---|
  | `/api/admin/health` | `Dashboard.jsx:74`、`Video.jsx:125`、`PublicLive.jsx:104`、`PublicReplay.jsx:300` | Dashboard(10s)、Video(10s)、PublicLive(30s)、PublicReplay(一次) |
  | `/api/admin/bilibili/queue` | `Bilibili.jsx:188`、`Dashboard.jsx:78`、`RecordingDetail.jsx:42`、`Video.jsx:124` | Bilibili(15s)、Dashboard(10s)、RecordingDetail(5s)、Video(10s) |
  | `/api/public/live` | `Dashboard.jsx:77`、`Live.jsx:45`、`PublicLive.jsx:103` | Live(8s)、Dashboard(10s)、PublicLive(30s) |
  | `/api/admin/recordings` | `Dashboard.jsx:75`（limit:10）、`Video.jsx:123`（**无 limit**） | Dashboard(10s)、Video(10s) |

- **状态重复源实例（同一事实两处维护）**：`Dashboard.jsx` 与 `Video.jsx` 各自算"已归档 / 待上传 / 磁盘用量"；`Video.jsx:346-353` 用 `recordings.filter(...)` 现算，`Dashboard.jsx:99-108` 用 `useMemo` 另算一套 `uploadStatusRank` 映射（`Video.jsx:65-74` 又定义一份）。两处 `isUploaded`/`isUploadActive` 语义**已经分叉**：`Video.jsx:80-88` 把 `"pending"` 算作 active，而 `statusText`（`Video.jsx:46-63`）里**没有 `pending` 的文案** → 状态为 `pending` 的录像会显示原始英文 `pending`（`Video.jsx:553` 的 `|| item.status || "待处理"` 兜底成 `"pending"`）。
- **后果场景**：`Dashboard` 显示"B站待上传队列 3 条"，`Video` 页"就绪可上传"显示 5 条，用户无法判断哪个对；根因是**队列合并逻辑只在 `Video.jsx:133-148` 存在**（按 `addedAt` + `uploadStatusRank` 去重取最新），`Dashboard.jsx` **未做同样合并**。

### M-4 大列表零虚拟化，30KB 级页面的重渲染风险 [已验证]
- **虚拟化普查**：对 `Video.jsx`/`PublicReplay.jsx`/`AutoRecord.jsx`/`Pocket48.jsx`/`Bilibili.jsx` 搜索 `react-window|virtuoso|virtualiz|IntersectionObserver|content-visibility` → **全部 0 命中**。
- **热点**：

  | 文件 | `.map(` 次数 | `useState` 数 | `.map(` 渲染规模 |
  |---|---|---|---|
  | `Video.jsx` | 5 | 14 | `filtered.map`（`Video.jsx:503`）渲染**每条**归档为 `<article>`，内含 1 张 `SafeImage` + 6 个按钮 + 3 个 `StatusBadge` |
  | `PublicReplay.jsx` | 6 | 19 | `filteredReplays.map`（`PublicReplay.jsx:660`），每个 `ReplayCard` **自持 `useState`**（`PublicReplay.jsx:106`）+ 1 个 `downloadTimer` ref |
  | `AutoRecord.jsx` | 12 | 23 | `visible.map`（`AutoRecord.jsx:505`）全量成员卡片，**带 `<select>` 内联样式块（`AutoRecord.jsx:534-549`）** |
  | `Pocket48.jsx` | 14 | 7 | 消息列表 |

- **重渲染放大路径（`Video.jsx`）** [已验证]：`usePolling(loadRecordings, 10000)` → `setRecordings(...)`（`Video.jsx:149`）**每次都创建新数组 + 新对象**（第 150-157 行 `.map` 返回新对象）→ `filtered` 的 `useMemo` 依赖 `recordings`（`Video.jsx:191`）必然失效 → **整张归档列表 100% 重建 DOM**，每 10 秒一次。**没有任何 `React.memo` 包裹**（全仓库 `React.memo` 使用数 = **0**，grep 0 命中）。
- **叠加放大**：`Video.jsx:167-171` 的 cover-batch 轮询每 5 秒 `setCoverBatch` → 触发**整个 `ArchivePage` 组件函数重跑** → 再次重建全部 `filtered.map` 的 JSX 元素树（React 会因 key 相同而复用 DOM，但**协调成本仍为 O(n)**）。
- **`AutoRecord.jsx` 的额外风险** [已验证]：每个选中成员的卡片内是**内联样式 + `<select>`**（`AutoRecord.jsx:534-549`），且 `toggle`（第 178-196 行）会 `setConfig` 产生**全新 members 数组** → `visible` 的 `useMemo` 依赖 `members`（第 164 行）必失效 → 点击任一成员复选框会**重渲染全部成员卡片**。现役成员数百人时，单次点击的协调开销与内联样式对象重建可感知卡顿。

### M-5 `PublicReplay.jsx` 下载轮询有泄漏边缘（组件级已处理，页面级有缺口）[已验证]
- **已正确处理**：
  - `ReplayCard` 内 `useEffect(() => () => window.clearTimeout(downloadTimer.current), [])`（`PublicReplay.jsx:113`）✓
  - 页面级 `useEffect(() => () => window.clearTimeout(downloadTimerRef.current), [])`（第 230 行）✓
  - `replayId` 变化时清 timer（第 231-234 行）✓
- **缺口**：`poll` 闭包（第 121-131 行与第 421-434 行）**通过 timer 链自我续期**，但**没有 `cancelled`/代际守卫**。若用户在 `startDownload` 后立刻切换 `replayId`（第 231 行的 effect 只清 `downloadTimerRef`），**`ReplayCard` 的本地 `downloadTimer` 不受影响**（它是另一个 ref），旧卡的 `poll` 会继续对**旧 replayId** 发请求直到 `ready`/`failed`。
- **后果场景**：用户连点多个回放的"下载视频"→ 每个 `ReplayCard` 保持 1 秒/次的独立轮询链，**N 个卡片 = N req/s**，直到各自完成。无上限、无并发控制。
- **同类**：`window.location.href = ...`（第 126、427 行）在轮询里触发整页导航，会**丢弃所有在途状态**——属可接受实现，但应注意 `ready` 状态与导航之间存在竞态（`setDownload` 后立即导航，React 可能来不及提交）。

### M-6 `TimelineEditor.jsx` 40ms 定时器 + `AutoRecord.jsx` 每秒倒计时 [已验证]
- **位置**：
  - `src/components/TimelineEditor.jsx:57` —— `setInterval(update, 40)`（25 FPS 重绘）
  - `src/pages/AutoRecord.jsx:126-130` —— `setTimeout` 链每秒 `setSmsCooldown`
- **问题**：`TimelineEditor.jsx:57` 是**手写 interval**，不经 `usePolling`，**不判断 `document.hidden`**。`AutoRecord.jsx:126` 的倒计时同理（但只在短信冷却期内，最多 60 次，影响小）。
- **后果场景**：`RecordingDetail` 页打开时间线编辑器后切走标签页，**25 次/秒的定时器在后台持续触发 React 重渲染**（浏览器虽会降频 `requestAnimationFrame`，但 `setInterval(…,40)` 不受节流保护，会被 clamp 到 1000ms —— 实际影响**有限**）。
- **定级说明**：这条我**主动降级为中**，因为现代浏览器对后台 `setInterval` 有 1s clamp，且该组件只在编辑弹窗内存在。属"应该修但不紧急"。

---

## 低优先级问题

### L-1 `App.css` 的"补丁式追加"结构 [已验证]
- 文件尾部 `App.css:2453-2509` 有 3 个**游离的补丁块**，用注释标注（`/* Recording covers retain portrait frames without cropping faces. */`、`/* Cover selection follows the archive's... */`），且 `App.css:2463` 与 `2465` 被压成**单行超长规则**（分别为 262 与 243 字符），与全文件其余部分的多行展开风格**不一致**。这是反复追加修复留下的痕迹。
- **后果**：后续维护者难以判断哪些规则是"现行设计"哪些是"历史补丁"，删除时容易误伤。纯可维护性问题。

### L-2 硬编码版本号 3 处，脱离 `package.json`/`VERSION` [已验证]
- 位置：`AdminLayout.jsx:141`（`v1.17.5`）、`PublicLive.jsx:208`、`PublicReplay.jsx:461`（`1.17.5`）
- **后果**：升版时需手动改 3 处，遗漏则**公开页显示旧版本号**。当前 `package.json`/`VERSION`/`index.html`/三个页面**均为 1.17.5，一致**，属**潜在**而非现存缺陷。
- **建议方向**：`vite define` 注入 `__APP_VERSION__`。

### L-3 `VideoPlayer.jsx` 的 `destroy()` 里有 `video.removeAttribute("src")` + `video.load()` [已验证]
- 位置：`src/components/VideoPlayer.jsx:41-49`
- **行为**：卸载时清空 `src` 并调用 `load()`。这是**正确**的（用于中断在途的媒体请求并释放解码器）。但 `playerRef.current?.destroy?.()`（第 45 行）在 **hls.js** 上会触发其内部 `detachMedia`，随后第 47-48 行再次操作 `video` —— 顺序合理。
- **唯一遗漏**：`hls.stopLoad()` 只在 fatal 错误分支调用（第 126 行），正常路径不调 —— 由 `destroy()` 覆盖，**无泄漏**。
- **结论**：**此项实现正确**，列出仅为记录"已核查、无问题"。

### L-4 `AdminLayout.jsx` 导航 3 次重复 rendering 逻辑 [已验证]
- 位置：`AdminLayout.jsx:81-97`、`99-115`、`117-133` —— 三段 `navItems.slice(...).map(...)` 代码**逐字重复**，仅 slice 区间与 `sidebar-section-label` 文案不同。
- **后果**：纯可读性/维护性。改样式需改 3 处。

### L-5 `AutoRecord.jsx` 内联样式量 [已验证]
- 位置：全文件 **35 处** `style={{...}}`（全仓库最高，第二名 `Security.jsx` 19 处）。
- **后果**：无法用 CSS 覆盖（需 `!important` 或改 JS），主题/暗色模式改造会被这里卡住。与 `M-4` 的重渲染问题叠加（每次渲染重建 35 个样式对象）。

### L-6 `dist/` 是否过期 [已验证 —— 结论：**未过期**]
- 用户假设"有没有提交了过期产物"，**实测未发现**：
  - 最新 src 文件 `AdminLayout.jsx` mtime = `2026-10-11 18:49:15`
  - 最新 dist 文件 mtime = `2026-10-11 18:51:29`（构建晚于源码 **2 分 14 秒**）
  - **src 中比 dist 构建时间更新的文件数 = 0**
- **但**：项目**无 `.gitignore`**（`1.0.2/client/.gitignore` 不存在），且本机**未安装 git**（无法核对版本控制状态）。dist 是否被纳入发布包/版本库**未验证**。
- **风险提示**：`test/` 下 7 个 Playwright 测试全部 `express.static(dist)` 后 `page.goto(...)`（如 `archive-layout.test.js:13-16`）—— 它们**测的是构建产物，不是源码**。若忘记 `vite build`，**这些测试会全部通过但测的是旧代码**（假绿）。当前 dist 新鲜，故此风险**未兑现**，但缺少防护机制。

---

## 测试有效性专项结论

### 先说结论：任务描述的预设**不成立**，实际情况显著更好

任务称"18 个 `.test.js`，用 `node --test`，**没有测试框架、没有 jsdom**"，并推测"如果只是对源码做正则匹配/字符串断言，那就是脆弱测试"。**实测结果**：

- **确实没有 jsdom**、确实用 `node --test` —— **这部分正确**。
- **但 7/18 个文件是 Playwright 真实 Chromium E2E**，通过 `createRequire(new URL('../../server/package.json'))` 复用 **server 侧**的 `playwright`（`1.0.2/server/package.json` 的 dependencies 含 `playwright: ^1.49.0`，`server/node_modules/playwright` 存在、`client/node_modules` 亦存在）[已验证]。
- 另有 **2 个文件走 `vite.ssrLoadModule` 真实执行源码** [已验证]：
  - `dashboard-health.test.js:14` 加载 `Dashboard.jsx` 并直接调用 `getDashboardStatus(healthy/partial/unavailable)`，用 `assert.deepEqual` 校验三种状态的 `badge`/`label`/`failedRequests` —— **这是真正的逻辑单元测试，有真实覆盖价值**。
  - `auto-record-page.test.js:65,87,121` 加载 `AutoRecord.jsx`，测 `normalizeMember` 的字段归一化、`filterMembers` 的团体/队伍二次筛选、以及 `renderToStaticMarkup` 能渲染出标题。

**按断言方式分类（18 个文件，均已抽样阅读）**：

| 类别 | 数量 | 文件 | 能捕获什么 / 不能捕获什么 |
|---|---|---|---|
| **A. 真实浏览器 E2E** | **7** | `archive-layout`、`archive-storage-ui`、`cover-ui`、`draft-delete-ui`、`pocket48-login-ui`、`pocket48-ui`、`replay-recovery-ui` | **能**捕获：渲染崩溃、路由 404、交互回归、移动端横向溢出、可访问性角色缺失、`pageerror`。**不能**捕获：后端真实契约、并发竞态、轮询泄漏（测试都在数秒内结束） |
| **B. SSR 真实执行（逻辑单测）** | **2** | `dashboard-health`、`auto-record-page`(部分) | **能**捕获：纯函数逻辑错误。**不能**捕获：React 副作用、清理函数 |
| **C. 纯函数单元测试（真值断言）** | **5** | `admin-credentials`、`danmaku`、`playback`、`replay-danmaku`、`replay-groups` | **能**捕获：解析/归一化/安全过滤的边界。**质量最高的一类** —— 例如 `danmaku.test.js:18-19` 断言 `must-not-leak` 与 `private.example` 不出现在输出中，是**真实的敏感信息泄漏回归测试**；`playback.test.js:29-30` 同理 |
| **D. 源码字符串断言（脆弱）** | **6** | `archive-processing`、`archive-storage`、`playback-policy-page`、`replay-import-ui`、`replay-danmaku`(:33-46)、`auto-record-page`(:9-55、:98-111) | **几乎什么都捕获不了**，见下 |

### D 类脆弱测试的**具体证据**（这是真正需要指出的问题）

**D-1 `archive-storage.test.js`（全文仅 13 行，5 条 `assert.match`）** —— 断言 `Video.jsx` 源码里存在这些**字面量**：
```js
assert.match(source, /adminApi\.get\("\/health"\)/);       // 第 8 行
assert.match(source, /可用磁盘/);                          // 第 9 行 —— 注释/文案
assert.match(source, /总计 \{formatBytes\(storage\.total\)\}/); // 第 10 行 —— 连模板串写法一起锁死
assert.match(source, /role="progressbar"/);                // 第 11 行
assert.match(source, /storage\.usedPercent/);              // 第 12 行
```
- **能捕获**：有人把 `total` 改名或删掉 `role="progressbar"`。
- **不能捕获**：`formatBytes` 算错、`usedPercent` 是 `NaN`、进度条渲染成 0 宽、aria 属性错误。
- **反效果**：第 10 行把**代码格式**（模板字符串里放什么表达式）变成了测试契约。把 `{formatBytes(storage.total)}` 重构为 `{formatBytes(storage?.total)}`（一个**增强健壮性**的改动）就会**测试失败**。这是典型的"**测试阻碍正确重构**"。

**D-2 `archive-processing.test.js`** —— 第 11 行 `assert.match(page, /自动录制支持官方回放补全/)` 断言的是 **UI 说明文案**（对应 `Video.jsx:490` 的 `<strong>`）。第 13 行 `assert.match(page, /waiting_merge: "等待续播"/)` 断言的是 `statusText` 映射的字面量。**改一个错别字或优化文案 → 测试红**；而真正的行为（合并后的 MP4 能否播放）**完全没测**。

**D-3 `playback-policy-page.test.js`（22 行，8 条 match）** —— 第 19 行 `assert.doesNotMatch(publicLiveSource, /直连优先|服务器中转/)`，即**断言"公开页源码里不许出现这两个词"**。注释里写一句说明文字就会让测试失败。第 20-21 行断言 `playerSource` 含 `const tryFallback = () =>` 与 `if (!tryFallback()) showError` —— 锁死**局部变量名与调用形态**。

**D-4 `auto-record-page.test.js:23`** 最典型：
```js
assert.doesNotMatch(source, /设置 20 路代表允许并发尝试/);
```
这是一条**否定断言，针对一句已经被删掉的旧提示文案**。它**永远为真**（只要不把这句话加回来），**零信息量**，纯属历史遗留。

**D-5 `auto-record-page.test.js:9-14`** 测的是"`AutoRecord.jsx` 里有 `import React, {...useCallback` 和 `export default function AutoRecordPage(`"——即**用正则验证语法**，而 `test:121-124` 的 `ssrLoadModule` + `renderToStaticMarkup` **已经真实证明了文件能编译能渲染**。前者是后者的严格弱化版，**冗余**。

**D-6 `replay-danmaku.test.js:33-46`** 前半段（第 6-31 行）是**优秀的纯函数测试**（`firstMessageAfter` 的边界、`replayDanmakuAt` 的前后 seek），后半段堕落为字符串断言：
```js
assert.match(source, /\}, \[enabled, normalizedReplayId, available\]\);/);   // 第 35 行 —— 锁死依赖数组的精确写法
assert.doesNotMatch(source, /\[enabled, normalizedReplayId, available, status\]/); // 第 36 行
assert.match(styles, /\.replay-player-shell \{\s*aspect-ratio: 16 \/ 9;/);   // 第 43 行 —— 断言 CSS 源码
```
第 35 行把 **`useEffect` 依赖数组的精确文本**变成契约。往依赖里加一个 `id`（**可能正是修复 bug 所必需的**）就会失败，而**真正的 bug（`status` 进依赖导致自取消）根本没有被行为化测试覆盖**。第 43 行断言 `App.css` 的**源码格式**（含 `\s*` 匹配换行），一旦用 Prettier 格式化或改单行写法即红。

### 覆盖盲区（所有 18 个文件共同缺失）

用 `test/` 全目录搜索确认，以下**零覆盖**：

1. **`usePolling.js` 完全没有测试**。它的三个核心承诺（隐藏时暂停、恢复即刷、指数退避）**一条都没测**。而我上面报的 **H-2、H-5 两个真实缺陷正落在这个文件里**。`fake timers` 依赖不可用（无 jsdom/jest），这类测试在当前基础设施下**无法编写**。
2. **`api.js` 没有任何测试**，**H-3（无 401 处理）无覆盖**。
3. **`AuthGuard.jsx` 没有测试**，**B-1（默认放行）无覆盖**。
4. **请求竞态与过期回写无覆盖**：`PublicReplay.jsx` 的 `listRequestRef`/`detailRequestRef`/`playerRequestRef` 三套代际守卫（第 225-227、260、314、359、368 行）是**精心设计的竞态防护**，但**无测试证明它有效**。
5. **播放器实例生命周期无覆盖**：`VideoPlayer.jsx` 的 `destroy()`（第 41-49 行）在 hls.js/flv.js 下的行为、`retryTimer` 清理、`removePlayerListeners` 正确解绑 —— 全部未测。E2E 测试里 `/file` 直接返回 404（`replay-recovery-ui.test.js:23`），**播放器从未被真实驱动**。
6. **`!`：E2E 测试的 mock 层屏蔽了真实契约**。7 个 Playwright 测试都 `page.route('**/api/**', ...)` 全量拦截（如 `archive-layout.test.js:23`），响应体是测试自己编的。所以**后端字段改名、`{success,data}` 信封变化、分页游标语义变化——E2E 全绿**。`listPayload`（`api.js:21-33`）那种"猜 5 种 key"的防御式代码正是这种不确定性的产物，**没有任何测试锁定它该猜哪些 key**。

### 基础设施缺口

- **假绿风险**：7 个 E2E 测试跑的是 `dist/`（`archive-layout.test.js:13`），**不是 `src/`**。`npm test` 前**没有 `npm run build`** 钩子（`package.json` 的 `"test": "node --test"` 裸调用）。忘记构建 → 测试绿但测的是旧代码。**H-1 的播放器泄漏问题，这套测试永远发现不了**（它只关心 DOM 是否渲染，不关心网络面板下载了多少 KB）。
- **串行依赖外部二进制**：`chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })` **硬编码路径**（`pocket48-ui.test.js:10`、`archive-storage-ui.test.js:14`、`cover-ui.test.js:13`）。只有 `archive-layout.test.js:18`、`replay-recovery-ui.test.js:12` 用了 `process.env.CHROMIUM_PATH || '/usr/bin/chromium'`。**同一仓库两套约定**，在 CI 或换机器时**6 个测试会因找不到 Chrome 而失败**（或更糟：被静默跳过）。
- **E2E 测试写文件到仓库**：`pocket48-ui.test.js:29-30`、`archive-storage-ui.test.js:36`、`cover-ui.test.js:51` 会 `page.screenshot()` 到 `../../docs/*.png`。测试有**副作用**，且 `cover-ui.test.js:50` 还 `fs.mkdirSync`。这不是单元测试该做的事。
- **单文件 32 行塞进一个巨型用例**：`pocket48-ui.test.js` 单个 `test()` 内串了签到、房间消息、加载更早、加入监听、开始/停止监听、切换 tab、截图、移动端断点、切账号共 **10 个场景**。任一步骤失败 → **后续全部不执行**，且报错定位困难。

### 测试有效性总评

| 维度 | 评价 |
|---|---|
| 断言强度 | **B** —— C 类（5 个纯函数）+ A 类（7 个 E2E）+ B 类（2 个 SSR）是**真实有效的测试**；D 类（6 个）是**负资产** |
| 覆盖完整性 | **D** —— 最强风险的 4 个模块（`usePolling`/`api`/`AuthGuard`/`VideoPlayer` 生命周期）**零覆盖** |
| 抗重构性 | **D** —— D 类测试锁死变量名、依赖数组文本、注释文案、CSS 格式 |
| 环境可移植性 | **C** —— 硬编码 Chrome 路径、缺 build 钩子、E2E 写文件到仓库 |
| **总体** | **C+** —— **不是**任务预设的"全是正则匹配"，但**真正脆弱的那 6 个文件确实构成净负担**，且**高危模块的覆盖空洞比脆弱测试更值得优先处理** |

**建议优先级**：① 删掉 D 类 6 个文件中的否定断言与格式断言（尤其 `auto-record-page.test.js:23`、`archive-storage.test.js:10`、`replay-danmaku.test.js:35,43`）；② 给 `usePolling` 引入 `@sinonjs/fake-timers` 或 vitest，补 3 个行为测试；③ `npm test` 前强制 `vite build`。

---

## 仅风格偏好（非问题）

以下是我**评估后判定为"不应作为缺陷上报"**的项，列出以避免后续误改：

1. **`App.css` 单文件 2510 行 / 59.6KB 是否该拆？**
   实测：跨文件重名类仅 4 组通用词（`M-1` 表），无循环依赖，构建产物 **47KB（gzip 前）** 对全站单页应用属**正常量级**。**不建议为此重构** —— 收益（可读性）低于风险（全局样式回归）。`index.css`(140行) 与 `App.css` 的职责**已实质分离**（前者 variables+reset，后者组件），**无需调整**。

2. **`App.css` 尾部补丁块的写法**（`L-1`）
   压成单行是为减小体积的常见做法，展开更好读但**纯偏好**。

3. **`src/lib/api.js` 的 `payload()`/`listPayload()` 防御式设计**（`api.js:15-33`）
   逐个猜 key（`recordings`/`items`/`data`/`content`…）看起来很脏，但**在没有后端契约文档的前提下这是务实选择**。问题在**缺少测试锁定**（见测试章节），不在写法本身。

4. **`AdminLayout.jsx:81-133` 三段重复 map**
   违反 DRY，但**只有 3 处、终态稳定**，抽出 `renderNav()` 的收益有限。

5. **组件不加 `React.memo`**（`M-4` 提及）
   我**不**把"零 `React.memo`"本身列为问题 —— 大部分组件在 `admin` 路由下**每次只渲染一个页面**。仅在 `M-4` 识别的**大列表 + 高频轮询**组合下才成为问题。

6. **`App.css:35` 的 `transform: none !important`**
   见 `M-1`，:disabled 与 :not(:disabled) 天然互斥，此 `!important` 属**冗余防御**，删掉不改变行为。**风格偏好**。

7. **`Pocket48.jsx` 的 JSX 密集压缩写法**（`Pocket48.jsx:149-188` 基本一行一个 section）
   可读性差，但**无功能风险**。

8. **`DanmakuOverlay.jsx` 用 `EventSource` 而非 `usePolling`**
   这是**正确**的（SSE 不是轮询）。`DanmakuOverlay.jsx:63-69` 的清理有 `active=false` + `source.close()` + `setStatus/setMessages` 重置，**实现完整**。属"已核查无问题"。

---

## 未验证的部分

以下我**无法在只读 + 无运行环境条件下确认**，明确标注，不作结论：

1. **H-5 的 `cover-batch` 状态回落**：`Video.jsx:172` 的 `useEffect` 依赖 `coverBatch?.status`，**若后端在批量任务完成后持续返回 `"done"` 而非回落到 `"idle"`**，则每次 `status` 值变化才触发。但由于 `usePolling` 每 5 秒 `setCoverBatch(payload(...))` 会**创建新对象**，`status` **字符串值不变**故 `useEffect` 不重跑 —— **所以只有"跃迁到 done 那一次"触发**。**未验证**：后端是否在某些路径下返回 `done → running → done` 抖动，若是则会退化为 5 秒一次全量刷新。需看 `1.0.2/server` 的 `/recordings/cover-batch` 实现。

2. **`AuthGuard` 之外是否有反向代理层鉴权**：`AuthGuard.jsx` 是**前端唯一门**这点已验证，但**后端 `/api/admin/*` 是否 401 拦截、是否有 nginx/网关层保护**未验证（本次仅审查 `client/`）。B-1 的真实影响**取决于后端是否严格** —— 若后端每个接口都校验，B-1 只是"UI 失效 + 满屏错误"；若后端有依赖前端守卫的接口，则升级为真风险。**建议 parent 侧核查 server 侧鉴权中间件**。

3. **`/api/admin/recordings` 无 limit 的真实响应体大小**：`Video.jsx:123` 未传 limit。当前线上归档条数未知，**未能评估实际带宽影响**（H-4 的严重度依赖此值）。需查生产 `/opt/shn48` 的录像数量或后端分页默认值。

4. **退避上限 60000ms 是否够**：`usePolling.js:57` 的 `Math.min(base * 2, 60000)`。以 `Dashboard` 的 10000ms 为基准：10s→20s→40s→60s→60s…**收敛正确**。但 `Video.jsx` 的 10000ms 基准下，**任何单次 `Promise.all` 的 reject 都会让整个轮询退避**（`Video.jsx:159` catch 整个）。**未验证**：若只有 4 个请求中的 1 个偶发失败（如 `cover-batch` 接口不稳定），是否会导致**健康请求也被拖慢到 60 秒一次**。从代码看——`loadRecordings` 用 `Promise.all`（非 `allSettled`，对比 `Dashboard.jsx:73` 与 `Live.jsx:44` 都用 `allSettled`），故**单个失败确会拖垮整体**，但**未在运行时验证**。

5. **HLS `lowLatencyMode: true` 的实际效果**：`VideoPlayer.jsx:97` 开启低延迟。**未验证**后端 HLS 是否用 LL-HLS 协议（若为普通 HLS，此选项无实际收益且可能增加请求频率）。

6. **`PublicLive.jsx` 未逐行审查**：本次重点在 `Video/PublicReplay/AutoRecord`。`PublicLive.jsx` 仅通过 `H-1` 的 import 与 `usePolling(loadLives, 30000)`（第 119 行）被涉及，**其内部 318 行未细读**。

7. **无 ESLint 配置的影响面**：`package.json`（33 行全文）确认**无 `eslintConfig`、无 `.eslintrc*`、无 devDependency `eslint`**。这解释了为何 `Pocket48.jsx:120` 那种 `useEffect(() => { refresh(); ... }, [])`（**空依赖但调用外部函数**）能进入生产。**但"若加 ESLint 会发现多少问题"未验证** —— 需要实际跑一次。

8. **`dist/` 与本仓库版本控制的关系**：本机**未安装 git**（`git` 命令不可用），且 `client/` 下**无 `.gitignore`**。因此**无法确认 `dist/` 是否被提交**（用户问题 7 的"有没有提交了过期产物"只能从 mtime 回答：**当前未过期**）。

9. **`1.0.2/client/test-client-deploy.log`（127KB）** 未审查 —— 可能是历史部署日志，与前端工程质量可能相关，本次未展开。

---

## 附：关键行号速查

| 问题 | 文件:行 |
|---|---|
| B-1 AuthGuard 默认放行 | `src/components/AuthGuard.jsx:15`（依赖数组 `[]` 在第 19 行） |
| H-1 播放器静态打入落地页 | `src/components/VideoPlayer.jsx:2-3`、`src/pages/PublicLive.jsx` 的 VideoPlayer import、`vite.config.js:26-28` |
| H-1 构建产物证据 | `dist/assets/PublicLive-BZs3NOYU.js`（含 `import"./hls-Byw5SIgA.js"`）、`dist/assets/VideoPlayer-Dh58dwxf.js` |
| H-2 可见性竞态 | `src/hooks/usePolling.js:60-66`、`:42-43`、`:52-57` |
| H-3 无 401 处理 | `src/lib/api.js`（全文 37 行，无 interceptor） |
| H-4 双轮询放大 | `src/pages/Video.jsx:166-171`、`:118-164`（`Promise.all` 无 limit） |
| H-5 手写 interval 逃逸 | `src/pages/ReplayAudit.jsx:36`、`src/pages/Bilibili.jsx:255-281`、`src/components/TimelineEditor.jsx:57` |
| H-6 Toast 无清理/无上限 | `src/components/Toast.jsx:25-29`、`:23` |
| M-1 死样式 | `RecordingDetail.css:16-23,31`（clip-*）、`App.css:1901`（.archive-actions）、`App.css:1866-1879`（.recording-name）、`App.css:1713`（.grid-3）、`App.css:205,217`（.public-alert） |
| M-1 动态类非问题 | `Badge.jsx:53`、`ProgressBar.jsx:19`、`Dashboard.jsx:122`、`ReplayAudit.jsx:51` |
| M-1 !important | `App.css:35`（冗余）、`App.css:2438`（必要，压 `AdminLayout.jsx:149-157` 内联样式） |
| M-2 未定义变量 | `ReplayAudit.css:1`（`--surface`、`--surface-hover` **无兜底**）、`Pocket48.css:1,3`、`AnalysisPanel.css:1`、`App.css:2465,2475` |
| M-3 重复轮询 | `Dashboard.jsx:74-79`、`Video.jsx:121-127`、`Live.jsx:44-47`、`Bilibili.jsx:188`、`RecordingDetail.jsx:42` |
| M-3 状态重复源 | `Video.jsx:65-88` vs `Dashboard.jsx:20-40`；`Video.jsx:133-148` 的合并逻辑 Dashboard 缺失 |
| M-4 无虚拟化/无 memo | `Video.jsx:503`、`PublicReplay.jsx:660`、`AutoRecord.jsx:505`；全仓库 `React.memo` = 0 |
| M-5 下载轮询并发 | `PublicReplay.jsx:113,121-131,230-234,415-439` |
| L-2 硬编码版本 | `AdminLayout.jsx:141`、`PublicLive.jsx:208`、`PublicReplay.jsx:461` |
| L-6 dist 新鲜 | dist mtime 比最新 src 晚 134 秒；比 dist 新的 src 文件 = **0** |
| D 类脆弱测试 | `archive-storage.test.js:8-12`、`archive-processing.test.js:11-16`、`playback-policy-page.test.js:19-21`、`auto-record-page.test.js:23`、`replay-danmaku.test.js:35,36,43` |
