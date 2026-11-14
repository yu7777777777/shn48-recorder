# shn48 前端检查报告（2026-10-29）

## 结论

本地 app/client 全量现有测试通过：45 个测试文件、132 项测试、132 通过、0 失败、0 取消、0 跳过；耗时 207651.42ms。独立 Vite 生产构建通过，转换 151 模块，输出 44 个文件，未覆盖正式 app/client/dist。

这不是“所有功能生产验收完成”。本地测试为源码断言、组件测试、真实 Chrome + mock API 的组合；生产只读浏览器冒烟仅覆盖公开首页、重播列表、一条重播详情。生产管理端未访问，未登录，未下载、上传、删除、发布或主动点击播放。

本地与生产打包前端不是同一份产物（lead 已独立确认 bundle 名不同），因此以下本地回归结论不能直接等同于生产登录态全部功能通过。

## 工具链与隔离方式

Node 不在默认 PATH。使用本机已经存在的 DSH bundled Node v24.21.0：

`C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe`

既有 pnpm 11.8.0 的位置为：

`C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`

使用既有 Chrome 156.0.8078.49，位置 `C:\Program Files\Google\Chrome\Application\chrome.exe`。本机还发现 Edge；未下载安装工具。

先读取根 AGENTS.md、前端 package scripts、Vite 配置和测试写入点。app 无根 package.json；client scripts 为 test=`node --test`、build=`vite build`，未发现 client 下额外 AGENTS.md。

测试发现两类越界风险：部分测试会写 app/docs 截图；social-browser 及若干 Vite 测试会写默认 node_modules/.vite，部分测试直接服务 ../dist。为避免写正式 docs/dist/runtime，将 client/src、test、public、package.json、index.html、vite.config.js 原样复制到本报告目录下 `workspace/app/client`，复制上层 VERSION 及测试只读依赖的少量 server 源文件，创建独立 docs 目录。本次未启动真实业务后端；测试 HTTP 服务器绑定 127.0.0.1 随机端口。现有依赖通过节点链接复用，不复制运行数据或凭据。TEMP/TMP 指向本报告目录下 temp，CHROMIUM_PATH 显式设置为已有 Chrome，UI_BASE_URL/UI_SCREENSHOT 从测试进程环境清除。

源码和测试副本共有 112 个文件，执行后逐一 SHA-256 比较均与正式来源相同。正式 dist/index.html 修改时间仍为 2026-10-26 10:44:09。未改业务源码、正式版本或正式应用配置。

### 必须披露的执行偏差

第一次在副本运行 bundled pnpm run build --outDir dist 时，副本未准备 .bin 入口，命令运行链意外触发供应链校验和依赖状态同步，日志出现 `Verifying lockfile against supply-chain policies`、`Already up to date`，并在副本创建 pnpm-lock.yaml。尽管没有主动执行 install 命令、日志未显示下载包，但不能将这次执行描述为严格的“零安装阶段”。更重要的是，副本 node_modules/.pnpm 是复用原目录的 junction，经事后检查，原 app/client/node_modules/.pnpm/lock.yaml 于 18:00:54 被重写。这是本次审计的隔离偏差，不能宣称所有共享文件零写入。

正式 package.json、pnpm-lock.yaml、node_modules/.modules.yaml 仍保持此前修改时间。未凭猜测回滚共享 .pnpm/lock.yaml，也未删除他人文件。发现后停止通过 pnpm 执行任务，改用 bundled Node 直接运行原有 Vite CLI，再次构建成功。所有业务源码、正式 dist/runtime 均未更改。首轮完整输出保留在 build.log / build.log.utf8.txt。

## 真实执行命令

工作目录为 `audit/2026-10-29/frontend/workspace/app/client`。

首次构建命令（含上述自动依赖阶段偏差）：

```powershell
$env:PATH='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin;'+$env:PATH
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' run build --outDir dist
```

最终独立构建命令（没有调用包管理器）：

```powershell
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe' 'D:\飞牛同步\AI资料库\AI项目空间\shn48录制\app\client\node_modules\vite\bin\vite.js' build --outDir dist
```

全量测试命令：

```powershell
$env:CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
Remove-Item Env:UI_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:UI_SCREENSHOT -ErrorAction SilentlyContinue
$env:TEMP=(Resolve-Path '../../..').Path+'\temp'
$env:TMP=$env:TEMP
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe' --test --test-concurrency=2 --test-timeout=180000 --test-reporter=tap 'test/*.test.js'
```

命令输出通过 Tee-Object 保存；Windows PowerShell 原始日志为 UTF-16，另生成 UTF-8 文本副本方便检索。测试并发限制为 2；有 180 秒超时保护，避免 Linux 默认 Chromium 路径或资源争用导致无限等待。

工作区根目录执行浏览器冒烟命令：

```powershell
$env:CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe' audit/2026-10-29/frontend/smoke.cjs
```

该脚本只创建临时静态/mock 测试服务器，不是替代生产服务器。所有浏览器上下文关闭后服务器随脚本退出。

## 本地构建与测试证据

构建退出码 0，Vite 6.4.4，151 modules，最终构建 2.60 秒；44 个文件的路径、大小、SHA-256 已写入 summary.json 的 buildFiles。唯一构建告警：hls chunk 为 595.07kB（gzip 185.87kB），超过默认 500kB 提示阈值，不是构建失败。其余主要 vendor-react 166.20kB、flv 156.60kB。

测试 TAP 最终汇总为 tests 132 / pass 132 / fail 0 / skipped 0 / cancelled 0 / todo 0。TAP 顶层 plan 为 1..124，另包含嵌套测试，所以最终测试总数为 132，不能把 124 当成总数。

测试虽然全通过，但日志并非无告警：出现 HMR 24678 端口占用信息 14 次、Vite 关闭时 outdated request 文本 306 次、fixture 记录的 WebSocket closed without opened 2 次。这些发生在测试 Vite/HMR/依赖扫描的启动或清理阶段；未导致断言失败。保留原始证据，未将它们伪装成生产页面故障，也未修改源码压掉日志。

## 主要页面与功能覆盖

公开页面：直播列表数字类型和搜索、错误/空状态、重播分类与团体层级、详情版式和持久化、弹幕时间轴和竞态取消、摘要公开/未公开/仅章节、多语言与慢加载提示、下载准备流程过期请求取消、导出 profile 请求及后端错误展示。

管理页面：Overview 中英文与部分服务异常；自动录制页面构建、成员目录/团体团队筛选、登录状态文案；归档列表、桌面/移动布局、磁盘容量、六类存储文件与清理确认；录制详情分析面板、双语 WebVTT、证据/溯源、队列健康和重试费用确认、批量审核与发布开关；回放导入预览/确认/已有归档复用、恢复进度和上传保护；B站草稿删除确认/取消/失败保留；封面选择；115 备份状态/选择/删除保护/二维码轮询/兼容响应；口袋48登录方式隔离、关注管理与聊天记录读取；社交账号 CRUD、昵称识别竞态/输入法/安全链接、移动导航、公开分享访问码；旧工具路由重定向。

这里“覆盖”指现有测试确有相应断言，不代表全部页面每个按钮都做了真实后端端到端验收。账号、安全设置等未有真实服务集成操作；录像、转码、B站上传、115传输、AI费用与外部账号行为均为 mock 或未测。

## 额外隔离浏览器冒烟

本地独立构建下，首页空状态、重播空状态、管理员登录页均 HTTP 200，无 JS pageerror、无同源 HTTP 资源错误、无横向溢出。未登录访问 /admin/archive 最终跳到 /admin/login，保护生效。未提交任何账号或密码。对应 local-*.png 截图与 smoke-results.json 保留。

## 生产公开页面只读冒烟（独立结论）

时间约 18:08，使用全新浏览器上下文访问公开首页、/replays、/replays/1322464033778765824。三个文档均 HTTP 200，无 pageerror、无横向溢出。同源 JS/CSS 未发现加载失败。检查时首页已有 1 场直播，列表有 20 条重播；这是实时列表变化，不与 lead 稍早空直播列表矛盾。

所有跨源请求（Google Fonts、48.cn封面/头像）、媒体资源和下载/导出路径被主动阻断，所以对应 ERR_BLOCKED_BY_CLIENT 不计为站点故障，封面真实加载与外部字体可用性未验证。未点击播放或下载；详情页会自行请求播放信息，播放器黑屏/不播放是该受限冒烟的正常边界，不能据此宣称媒体链路已验收。

详情 /summary 返回 404，但源码明确其为可选“管理员未发布摘要”分支，页面不崩溃、不渲染空摘要，不作为功能失败。实际生产详情画面明确显示“横屏、竖屏及仅音频转码尚未接入后端，暂不可导出”，导出按钮禁用：这是已披露的未完成功能，不能将前端 profile 请求测试通过表述为生产多版本转码可用。

发现真实数据一致性问题：同一条回放在列表有成员 SNH48-吉雅楠 与时间 2026/10/29 07:19，但直接详情显示“口袋48成员·时间待更新”。公开详情 API HTTP 200 返回 member 的 id/name/avatar 为空、startedAt=null。证据见 production-detail-observation.json 和 production-replay-detail.png。这不属于 JS 崩溃，但建议作为详情元数据缺失问题跟进。

生产管理员登录态、后台路由和未登录生产保护严格未测；未请求凭据。

## 证据索引

- REPORT.md：本报告。
- tests-full.tap / tests-full.tap.utf8.txt：全量测试原始输出与可检索文本。
- build-direct.log / build-direct.log.utf8.txt：最终直接调用 Vite 的构建日志。
- build.log / build.log.utf8.txt：首次含依赖同步偏差的构建日志。
- summary.json：测试名称、最终计数、告警计数、112 个副本文件一致性、44 个构建文件哈希。
- smoke.cjs / smoke-results.json / smoke.log：冒烟脚本、原始逐页结构化结果与命令输出。
- local-home.png、local-replays.png、local-admin-login.png、local-admin-protected.png：本地构建截图。
- production-home.png、production-replays.png、production-replay-detail.png：生产公开页面截图，跨源图像故意阻断。
- production-detail-observation.json：公开详情接口元数据缺失证据。
- workspace/app/docs：现有测试自行生成的归档/口袋48移动与桌面截图。
- workspace/app/client/dist：隔离构建产物，非发布目录。

## 未验证范围

真实后台端到端读写、生产鉴权/会话失效、外部账号登录、短信/二维码实际授权、生产录像生成和断流恢复、播放成功与音画同步、长时播放/大文件下载、后台转码/导出、B站上传发布、115真实传输、AI真实模型费用、跨源封面/字体、完整浏览器兼容矩阵、真实手机/触屏设备、压力/性能/可访问性全面审计均不在本次结论中。
