# 1.17.5 全栈体检总览（2026-10-14）

只读体检，**未修改任何源码**。四个角色并行审查前端体验、前端工程、后端健壮性、发布与线上状态。

- 本文件路径：`app/docs/releases/`（该目录被 `scripts/manifest.mjs` 排除，新增文档不影响 `SHA256SUMS`）
- 详细报告：`release-audit-20261014.md`（发布/线上侧）、`../client/FRONTEND-AUDIT-1.17.5.md`（前端工程侧）
- 体检范围：`app/client/src`（19 页面 + 19 组件 + 6 CSS）、`app/server`（index/routes/lib/modules + 30 测试）、`docs/releases/`、线上 `/opt/shn48`

---

## 一、结论摘要

**线上是干净的。** 版本一致性、哈希清单、容器状态全部通过：

| 校验项 | 结果 |
| --- | --- |
| 7 处版本位置一致性 | 全部 `1.17.5` |
| `SHA256SUMS` | 254/254 匹配，0 缺失（本次复核复现） |
| `RUNTIME-SHA256SUMS` | 135/135 匹配；容器内 `total=135 mismatches=0` |
| `client/dist` 产物 | 37/37 在清单内且匹配，未被改动 |
| 线上健康接口 | `version=1.17.5` |
| 未认证管理接口 | `401` |
| 容器 | `shn48-recorder` healthy，镜像 `shn48-shn48:1.17.5` |
| Compose 加载 | `docker-compose.yml` + `docker-compose.public.yml`，符合纪律 |

**问题集中在代码与记录，不在部署。**

---

## 二、阻断级问题

### B1 — 转写在有直播录制时必然失败

**证据链（已独立复核）**

```
offline.js:32   transcribe() → worker(..., interruptOnRecording=true)
offline.js:20   每 2 秒 setInterval → if (recording()) kill('WAIT_RECORDING')   // SIGKILL
offline.js:10   recording() = getRecordings().some(r => r.status === 'recording')
service.js:192  在转录循环内部调用 waitForRecording(job)
service.js:194  catch (e) { if (e.message === 'WAIT_RECORDING') continue; }      // 杀了再试
```

**机制**：`recording()` 判定的是"库里存在任意录制中的记录"，而非"本次转写任务自身的媒体是否正在录制"。自动录制是常态，因此任何转写任务在录制期间启动（或运行中恰有直播开始）都会被自身逻辑 SIGKILL。`service.js:194` 的 `continue` 让它循环重试，形成反复重启子进程。

**影响**：离线/在线 ASR 在录制期间不可用，且错误文案为"离线引擎未安装或无法启动"，把用户引向错误的排查方向。

**佐证**：`test/offline.test.js:8` 的 `waitFor()` 超时失败正是此缺陷的表现；1.17.5 发布记录将其归入"基线中的测试失败"而未深究。

**修复方向**（未实施）：`recording()` 应只判定与该任务相关的活动录制会话；`interruptOnRecording` 只对"启动前"生效，运行中改为排队而非 SIGKILL；错误文案区分"录制优先等待"与"引擎未安装"。

### B2 — `replay-recovery` 初始化期异常可致进程退出

`modules/recorder/replay-recovery.js:14-22` 的 `directory()` 用 `fs.realpathSync(cache) !== cache` 做校验，在录制目录为符号链接或绑定挂载时抛错。`index.js` **没有** `process.on('unhandledRejection')` / `uncaughtException` 处理器（全仓仅处理 `SIGINT`/`SIGTERM`），Node 默认行为是终止进程 → 容器重启循环。

**前置条件未验证**：需确认线上 `RECORDINGS_DIR` 是否为符号链接。

---

## 三、高优先级问题

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| H1 | 落地页首屏实际约 1034KB，非发布记录所称 71KB | `PublicLive.jsx:17` 静态 import `VideoPlayer`；`VideoPlayer.jsx:2-3` 静态 import `hls.js`(579.2KB) + `flv.js`(152.5KB)。实测 dist chunk 体积 | 移动端访客打开首页 `/` 仍需下载约 1MB，兜底了 `vite.config.js` 的全部分包意图 |
| H2 | 公开页错误态永不显示 | `PublicLive.jsx:112` `catch { setLives([]) }`；`listError`(:94) 声明后全文无引用 | 后端故障时访客看到「现在没有正在进行的直播」，误判为无人开播而离开 |
| H3 | `AuthGuard` 默认放行方向错误 | `AuthGuard.jsx:15` 仅显式 `authenticated === false` 才拒绝；返回 `{}`/字段缺失/改名均放行。依赖数组 `[]` 从不复验 | 是唯一一道前端门。后端 `index.js:50` 有 `auth.requireAdmin` 兜底，故为"UI 失效 + 满屏错误"而非数据泄露 |
| H4 | `api.js` 无 401 处理 | 全文 37 行无 interceptor；全仓搜 `401`/`interceptors` 零命中 | 会话过期后用户卡在 admin 页，每 10 秒收一个红吐司，永不跳登录 |
| H5 | 封面渲染可无限挂起 | `lib/cli.js:9` 的 `spawn(bin, args, { timeout })` —— `timeout` 是 `exec`/`execFile` 的选项，对 `spawn` 无效 | `covers.pending` 永久持有 Promise，后续封面请求均返回 409，封面子系统死锁 |
| H6 | 配置写入非原子 | `routes/config.js:47` 直接 `writeFileSync`；1.17.5 的原子化未覆盖此 YAML 路径 | 写入期间容器被 kill 会截断 `config.yaml`，`loadConfig()` 仅打日志返回 `{}`，配置静默丢失 |
| H7 | 保留策略 4 个保护缺口 | `retention.js` 的 `protectedFiles` 未覆盖剪辑运行中的父记录源文件；`.official-replays` 在无 owner 时整目录清理；`complete.json` 引用的 `verified.mp4` 孤儿永不回收 | 24 小时延迟清理并未覆盖全部场景 |
| H8 | 优雅关闭不覆盖全部任务 | `graceful-shutdown.js:37` 只等 server + `stopRecorders`；MP4 合成、分片上传被 `process.exit` 硬切（`finally` 不执行） | 留下 `.processing.mp4` / `.part` 残留 |
| H9 | 轮询未真正统一 | `ReplayAudit.jsx:36`(2s) 与 `Bilibili.jsx:255`(2.5s) 仍为手写 `setInterval`，无 `document.hidden` 判断 | 1.17.5 宣称的"统一收敛到 usePolling"不属实 |
| H10 | 公开接口可无限创建 RTMP 中继 | `routes/public.js:100` 无鉴权；`rtmp-relay.js` 写容器 `/tmp`，周期拉分片可让中继永久保活（默认上限 20） | 公开站点任何访客可写满容器 `/tmp` |
| H11 | 明文 root 凭据落在同步盘 | `阿里云服务器.txt` 含 `密码` 字段；3 个 `ssh_stage*.py` 读取后登录 `<SERVER_IP>` root（`AutoAddPolicy` 不校验主机密钥）；根目录**无** `.gitignore`；工作区位于 `D:\飞牛同步\` | 违反 AGENTS.md 凭据禁令。未进入任何发布 tar 包，但复制/打包即泄漏。**建议轮换密码并改用密钥认证** |
| H12 | 9 个已发布版本无审计记录 | `docs/releases/` 缺 `1.16.0`–`1.16.4`、`1.17.0`–`1.17.2`；README 对应行全为 `—` | 功能最密集期无镜像 ID / 回滚材料可追溯 |
| H13 | 生产磁盘 80% | `/` 40G 用 30G（剩 7.7G）；`runtime/recordings` 19G；单场 `.flv`+`.mp4` 双份约 2.9G | 余量不足两场录制 |
| H14 | 镜像堆积 | 62 个镜像仅 2 个 active，3.694GB (99%) 可回收，含 16 个 dangling | 需人工核对后按 ID 定向清理，**禁止** `docker system prune` |

---

## 四、中优先级问题（择要）

**前端体验**

- 模态框无焦点陷阱（`ConfirmModal.jsx:26-69`）
- 成员卡片是 `<div onClick>`，纯键盘用户无法勾选（`AutoRecord.jsx:511-515`）
- 勾选成员只改本地 state，切页即静默丢失（`AutoRecord.jsx:178-196`）
- 上传队列失败无任何反馈，显示「没有待处理的上传」，用户以为任务消失（`Bilibili.jsx:184-230`）
- 原生 `window.confirm` 5 处与 `ConfirmModal` 双轨并存
- **26 个 CSS 断点**（360/380/500/600/680/700/720/750/768/950/980/1024/1040/1100/1150/1600），其中 10 个仅用一次，`700` 在三个文件各写各的
- `.page` 被 4 个页面使用但任何 CSS 都无定义；`.voice-row`/`.voice-list` 同
- **未定义 CSS 变量**：`ReplayAudit.css:1` 与 `App.css:2465` 使用 `var(--surface)`，`index.css` 只定义了 `--bg-surface`，无回退 → 卡片失底
- 硬编码颜色绕过令牌：`App.css` 中 167 处 hex + 49 处 rgba，而 `var(--token)` 仅 285 处；`:root` 定义的 `--accent` 等形同虚设
- 状态文案映射有 5 份重复实现
- 43/394 个类零引用（剔除动态拼接后真死代码约 10 组）
- `RoomVoice.jsx` 单行 2614 字符，且「移除监测」无二次确认、无撤销

**后端**

- 保留策略的 `verifyFull` 全量解码无并发/时长上限，10 分钟一次 sweep 可能与录制争抢资源
- `graceful-shutdown` 的超时路径 `process.exit` 使 `finally` 不执行
- `lib/sse.js` 无背压处理，慢客户端累积 `res.write` 缓冲
- `ddtalks` 把用户提供的 `meetingUrl` 直接交给 Playwright `page.goto`，无协议/主机校验（需管理员权限）
- 生产为公网明文 HTTP，且项目自注 `COOKIE_SECURE=false` 为"临时测试"但已持续到发布后 3 天

---

## 五、测试有效性结论（修正预设）

**测试强度好于预期，不是"全是正则匹配"**：

- **7/18 前端测试是 Playwright 真实 Chromium E2E**（`archive-layout`、`archive-storage-ui`、`cover-ui`、`draft-delete-ui`、`pocket48-login-ui`、`pocket48-ui`、`replay-recovery-ui`），测可访问性角色、移动端横向溢出、收集 `pageerror`
- **2/18 通过 `vite.ssrLoadModule` 真实执行源码**（`dashboard-health` 直接调用并断言三态）
- **5/18 是纯函数单测**，质量最高 —— `danmaku.test.js:18-19` 断言 token 与私有 avatar URL 不泄漏，是真实的安全回归测试
- **6/18 是字符串断言**，其中部分是负资产：`auto-record-page.test.js:23` 的 `assert.doesNotMatch(source, /已删除的文案/)` **永远为真、零信息量**；`archive-storage.test.js:10` 把模板串写法锁成契约，增强健壮性反而使测试失败

**真正的覆盖空洞比脆弱测试更值得处理**：

- `usePolling.js`、`api.js`、`AuthGuard.jsx`、`VideoPlayer` 生命周期 **零测试** —— 而 H3/H4/H9 正落在这些文件
- 后端入口层为零：`startServer()`、信号处理器、8 个启动动作的顺序与失败语义无测试
- `routes/public.js`（唯一的公开面，14.4KB）**无任何 HTTP 层测试**
- `lib/cli.js` 无测试（H5 因此长期未被发现）

**测试基础设施缺陷**：

- `package.json` 的 `"test": "node --test"` **前面没有 build 钩子**，而 7 个 E2E 跑的是 `dist/`（`archive-layout.test.js:13`）→ 忘记构建就会**假绿**
- 6 个测试硬编码 `C:/Program Files/Google/Chrome/Application/chrome.exe`，另 2 个用 `process.env.CHROMIUM_PATH || '/usr/bin/chromium'`，同仓两套约定，换机必挂
- E2E 会 `page.screenshot()` 写入 `../../docs/*.png`，测试带副作用

**发布记录所称"真实音频分片续传测试失败"的定位**：`test/analysis.test.js:49`，双重原因 —— 宿主机缺 `ffmpeg` 使用例在第 51 行断言失败（`null !== 0`），且 `service.execute()` 把 ENOENT 统一翻译成"媒体处理程序无法启动"，**使该用例的续传语义根本未被执行到**。即此失败既不能证明续传正常，也不能指出真实原因。

---

## 六、本机环境限制

| 工具 | 状态 | 后果 |
| --- | --- | --- |
| `node` / `npm` / `npx` | **缺失** | 无法运行 `node --test`、无法 `vite build`、无法 `node scripts/version.mjs` |
| `docker` / `git` | **缺失** | 工作区**不是 git 仓库**，版本管理依赖 `VERSION` + `CHANGELOG` + 哈希清单 |
| `python` (3.13) / `ssh` | 可用 | — |
| `ffmpeg` | 可用但来自 ImageMagick 目录，非专用构建 | 后端媒体相关测试无法可靠执行 |

因此 AGENTS.md 要求的"发布前执行版本检查、相关现有测试和前端构建"**在当前本机无法完成**。本次体检的哈希校验是直接比对磁盘文件，不依赖 Node。

另：Hindsight 记忆库未配置 API key（调用返回 401），本次结论无法写入长期记忆。

---

## 七、建议的处理顺序

1. **B1**（转写必败）—— 影响最大，且错误文案误导排查方向
2. **H11**（凭据）—— 需先确认该同步盘的实际同步范围，再轮换密码
3. **H13 / H14**（磁盘与镜像）—— 建议在下一场录制前处理，否则可能触顶致录制失败
4. **H1**（首屏体积）—— 改动局部（`VideoPlayer` 改动态 import），收益明确
5. **H2 / H3 / H4**（错误态与鉴权反馈）—— 均为用户体验的"沉默失败"
6. **H6 / H5**（配置原子写入、子进程超时）—— 修复成本极低
7. **H7 / H8 / H9**（保留策略、优雅关闭、轮询统一）
8. 其余中低优先级与文档补齐可择期进行

**注意**：本机无法验证修复效果。若决定改代码，建议先启用 Node 环境以恢复测试与构建能力；否则只能依赖服务器侧验证，回归风险较高。

---

## 八、线上现状（只读核对）

- 容器 `shn48-recorder`：Up 3 days，healthy，镜像 `shn48-shn48:1.17.5`，标签 `org.opencontainers.image.version=1.17.5` / `revision=release-1.17.5-20261011`
- 公开健康接口 `http://<SERVER_IP>:3000/api/public/health` 返回 `version=1.17.5`
- 未认证管理接口返回 401；已废弃 proxy 接口返回 404
- 唯一已停止容器：`shn48-recorder-rollback-1.17.2`（回滚材料，`1.17.5-audit.md` 已记录，**应保留**）
- 生产 `.env` 权限 600（含 3 个备份）；发布包内无 `.env`/cookies/`config.yaml`
- **结论：无需回滚，可继续 1.17.5 运行**

---

## 九、诚实边界

- 所有"界面看起来如何"的判断均由 CSS/JSX 静态推导，**未在浏览器中实际渲染**。视觉问题、真实对比度、响应式实际表现、`.page` 导致的 DOM 层级差异均未实测。
- 部分结论存在前置条件未验证：B2 需确认录制目录是否为符号链接；H10/H13/H14 建议值需结合实际磁盘余量与容器配置确认。
- 本机无 Node，`version.mjs check` 未能实跑，改为静态审读脚本 + 手工比对 7 处版本位置。**这不等于源码可重新构建出相同产物。**
- 本次体检**未修改任何源码**。源码文件 mtime 抽查确认仍为发布时的原始时间戳。
