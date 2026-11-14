# 本地后端全量自动化回归与覆盖审计

日期：2026-10-29（Asia/Shanghai）。范围：本地 `app/server`、现有版本检查脚本及必要的只读源码分析。执行者：backend-check。

## 结论

**不能据此宣称“所有功能正常”。** 已完整执行现有 87 个 JS 测试文件（508 项）以及单独的 Python worker 测试（30 项）。配置现有媒体工具后的全量结果为 **503 通过 / 4 失败 / 1 跳过**；对剩余失败所在 3 个文件有界串行重跑 **9/9 通过**。其中两个失败是审计隔离脚本干预测试自造账号，不是应用登录故障；另两个仅在全量并发运行时超出测试内 10 秒期限，串行复跑通过，保留时序/资源敏感性，不能称为已证实业务代码缺陷。没有一次“508 项单轮全绿”的执行记录。

另发现两项不依赖测试计数的确定问题：

1. **版本一致性检查失败**：VERSION 与 package.json 是 1.31.1，但两个 package-lock.json 的顶层和 packages[""] 都是 1.31.0；多个版本文档/构建文件未同步。smoke 脚本健康检查仍硬编码期望 1.31.0。
2. **自动回放巡检存在时间格式兼容缺陷**：normalizeReplay 保留毫秒数字字符串/数值，而 replay-watch.select 使用 Date.parse，导致窗口内本应选中的回放被过滤。纯函数复现已确认；这不等于当前已发生线上漏导入，是否启用不在本次本地测试结论内。

## 安全与隔离

- 先读取根 AGENTS.md，检查 server/package.json 的 `test: node --test test/*.test.js`、版本脚本及测试源码；未发现 app 下额外 AGENTS.md。
- 未访问生产、未启动正式应用服务、未读取真实 Cookie、密钥、.env 或正式运行数据；没有修改 app 源码、版本、锁文件、配置或其他成员文件。
- 写入仅在本报告目录与测试自身系统临时目录。Python 使用 `-B` / PYTHONDONTWRITEBYTECODE=1，避免在源码目录生成 __pycache__。
- 应用模块有危险的默认路径：admin-auth/room-state 可回落 server/runtime，config 可回落 app/config/config.yaml；store、Pocket48 API 和 B站 Cookie 可回落用户目录。因此在预加载任何测试模块前，审计 preload 将 DATA_DIR、RECORDINGS_DIR、HOME/USERPROFILE、CONFIG_PATH、COOKIES_PATH、DDTALKS_DOWNLOAD_DIR、STREAM_RELAY_DIR 指向系统临时目录；测试自己设置的临时 DATA_DIR 等继续生效。
- preload 对常用同步文件写入、改名、删除及 createWriteStream 加路径防护，拒绝 audit 与系统临时目录外的写入；阻止读取 app/server/runtime 与 app/config；阻止 Node Socket/fetch 非回环连接。它是审计辅助防护，不是操作系统级完整文件/网络沙箱；Python/FFmpeg 子进程依赖已审阅的临时输入路径，Python worker 使用 FakeClient/FakeFS，不连接115。
- 所有测试日志中未见 AUDIT_WRITE_BLOCKED / AUDIT_READ_BLOCKED / AUDIT_NETWORK_BLOCKED。没有读取正式 runtime 来作“前后内容对比”，也不以未做的哈希快照声称已验证其字节不变。
- 初版 preload 无条件覆盖 ADMIN_* 测试账号，造成 remembered-sessions 的子进程用例 401。仅调整本目录 isolate.cjs，让 REMEMBER_AUTH_TEST_CHILD=1 的子进程保留其明确自造的测试夹具；初版归档为 isolate-initial.cjs。未改测试或应用源码。

## 工具环境

- Windows；Node 未在默认 PATH，通过既有 DSH runtime 定位：`C:/Users/Administrator/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node.exe`，v24.21.0。
- 系统 Python：`C:/Users/Administrator/AppData/Local/Programs/Python/Python313/python.exe`，3.13.3，已有 numpy/PIL/cv2；DSH bundled Python 缺 cv2，所以封面真实测试选系统 Python，未安装任何依赖。
- 默认 PATH 有 ImageMagick 附带 ffmpeg，但没有 ffprobe，因此先保留原环境失败证据，再配置项目已有 `.tools/ffmpeg/ffmpeg-9.0.1-essentials_build/bin/{ffmpeg,ffprobe}.exe`，二者版本9.0.1。
- 未运行 npm install / lockfile生成 / version set / build / 发布或生产探针。

## 真实执行与计数

| 轮次 | 命令核心 | 结果 | 证据 |
|---|---|---|---|
| 首次启动尝试 | node app/scripts/version.mjs check；node --test ... | preload Windows反斜线被 NODE_OPTIONS 吞掉，MODULE_NOT_FOUND，未执行任何测试 | version.log.utf8、server-full.tap.utf8 |
| 版本检查（修正preload路径后） | node app/scripts/version.mjs check | exit1，client/package-lock.json: version mismatch | version-run2.log.utf8 |
| 原环境全量 | node --test --test-timeout=120000 --test-reporter=tap 'app/server/test/*.test.js' | 508：486pass、15fail、7skip；93.164秒 | server-full-run2.tap.utf8 |
| 指定既有FFmpeg/FFprobe全量 | 相同全量命令，指定 FFMPEG_BIN/FFPROBE_BIN | 508：503pass、4fail、1skip；135.291秒，exit1 | server-configured.tap |
| 具体失败文件串行复跑 | node --test --test-timeout=120000 --test-concurrency=1 --test-reporter=tap app/server/test/archive-integration.test.js app/server/test/offline.test.js app/server/test/remembered-sessions.test.js | 9pass、0fail、0skip；102.754秒，exit0 | targeted-rerun.tap |
| Python worker | python -B app/server/test/backup115-worker.test.py | 30pass，0.978秒，exit0 | python-worker.log.utf8 |
| 磁盘与保留策略补核 | node --test --test-timeout=30000 --test-concurrency=1 --test-reporter=tap audit/2026-10-29/backend/gate-semantics.test.cjs app/server/test/auto-recorder-space.test.js app/server/test/retention-main-file-guard.test.js | 19pass、0fail；设置 STORAGE_RESERVE_GIB=STORAGE_TARGET_GIB=999999 确保purge不走above-reserve早退 | gate-retention-forced.tap |
| 回放时间兼容补核 | node --test --test-concurrency=1 --test-timeout=30000 --test-reporter=tap audit/2026-10-29/backend/replay-time.test.cjs app/server/test/replay-import.test.js | 5个诊断/现有测试通过，其中1个确认了缺陷行为，不代表该功能正确 | replay-time.tap |

这些是重复覆盖不同环境/同一用例的执行，不可把各轮通过数相加当作唯一业务用例总数。完整87文件清单见 test-inventory.json。

### 配置轮共同启动环境（PowerShell；执行工作目录为仓库根）

```powershell
$node='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe'
$audit=Join-Path (Get-Location) 'audit\2026-10-29\backend'
$env:SHN48_AUDIT_ROOT=Join-Path $env:TEMP ('shn48-audit-backend-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:SHN48_AUDIT_ROOT | Out-Null
$env:NODE_OPTIONS='--require="'+((Join-Path $audit 'isolate.cjs') -replace '\\','/')+'"'
$env:COVER_PYTHON_BIN='C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:PYTHONIOENCODING='utf-8'
$env:FFMPEG_BIN=Join-Path (Get-Location) '.tools\ffmpeg\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe'
$env:FFPROBE_BIN=Join-Path (Get-Location) '.tools\ffmpeg\ffmpeg-9.0.1-essentials_build\bin\ffprobe.exe'
$env:PATH=(Split-Path $node)+';'+(Split-Path $env:FFMPEG_BIN)+';'+$env:PATH
& $node --test --test-timeout=120000 --test-reporter=tap 'app/server/test/*.test.js' 2>&1 |
  Out-File -Encoding utf8 (Join-Path $audit 'server-configured.tap')
```

注：全量当时加载的是初版 guard（现保存为 isolate-initial.cjs）；定点复跑用更正后的 isolate.cjs。原环境轮未设置 FFMPEG_BIN/FFPROBE_BIN，也未将项目媒体bin加PATH。第一批 PowerShell重定向产生UTF16日志；保留原文件，同时另存 .utf8 供阅读，没有替换原始证据。

## 失败定位

### 原环境工具缺失，不是已证实源码故障

server-full-run2.tap.utf8:884-915、1851-1862、2466起等有明确 `spawn ffprobe ENOENT` / `ffprobe 未安装或不在 PATH 中`。补上既有工具后真实音频分片、封面、回放下载/校验/恢复、房间音频归档、SRT导入通过，跳过由7项降为1项。

### 配置轮剩余4项

- manual stop immediately archives independently：server-configured.tap:908-924，超过测试内部10秒期限，错误 `manual archive should not wait five minutes`。串行复跑 targeted-rerun.tap:2-7 原用例通过（5.012秒）。这是并发资源/时序敏感性证据，不是已证明会等待5分钟。
- offline queue needs installed model...：server-configured.tap:2034-2055，等待phase进入等待录制状态的10秒断言失败。串行复跑:26-31通过（0.406秒）。未修改源码，不能仅凭该次超时判定离线队列业务故障。
- remembered login... 和 logout persists...：server-configured.tap:2358起，401 != 200；根因是初版 audit preload 无条件覆盖测试明确设置的 `remember-test` 凭据，属于审计夹具干扰。只修 audit guard后，原测试文件串行通过，见 targeted-rerun.tap:38-56。
- 唯一跳过：cover-media.test.js 的真实人脸帧优选/成员照片/原封面优先级用例，缺 COVER_FACE_FIXTURE，不是安装失败。空白视频模板及真实Python布局测试已实际通过。

## 确定缺陷与代码证据

### V1：版本/发布自检不一致

app/VERSION、server/package.json、client/package.json=1.31.1；两个 package-lock.json顶层及packages[""]仍1.31.0。补充只读检查还发现 Dockerfile、README.md、client/src/App.css、scripts/smoke-test.mjs、docker-compose.yml未含1.31.1；Dockerfile.release/client/index.html已含1.31.1。详见 version-details.json。

smoke-test.mjs:49 仍校验 `health.data.version === "1.31.0"`，故对真实1.31.1健康结果会误报。未连接任何服务执行该smoke脚本；这一条是源码确定性检查，不假装为运行结果。

### B1：replay-watch 数字时间戳遗漏

调用链：live.js:84 的 startedAt直接取 startTime/liveTime/ctime/createdAt；replay.js:85直接转发；replay-watch.js:69使用Date.parse，:70丢弃非有限结果。

replay-time.tap:26的隔离纯函数对照：

- 输入 `"1793229596318"`，normalizeReplay后仍为同样数字串，Date.parse非有限，selected=[]。
- 输入数值1793229596318，同样selected=[]。
- 相同时刻 ISO `2026-10-28T23:19:56.318Z`，selected=["990081"]。

三组均在同一个合法成员与有效窗口（since=1793229595318）内；因此不是测试样本恰好落在窗口外。现有 replay-watch.test.js:10-27仅用ISO时间，遗漏了normalizeReplay的真实时间格式。

**反证/排除项**：replay-import.js并非直接以原始数字构造endedAt；:57-64先兼容10-13位数字时间戳并转ISO，:111构造time后才:142 Date.parse(time)。现有 replay-import.test.js:65-102本来就覆盖数字串导入；这次重跑通过，不能据上述巡检缺陷推导手动回放导入必然RangeError。

## 自动录制磁盘gate与清理日志真实语义

- requiredBytes不是固定10GiB，也不等于minFreeGiB。auto-recorder.js:165-176：`max(0.5, minFreeGiB) GiB + bytesPerHour * assumedLiveHours`；默认最少测量地板0.2GiB/小时、假定3小时、minFreeGiB=2时为2.6GiB。历史平均用有效size/fileSize和始终时间估算；注释说“automatic”但:158实际查询所有非deleted录制，未按source或autoMonitorId筛选，所以回放归档也可能参与估算。具体现场门槛必须结合配置和历史，不可由版本号推断。
- :314-331先ensureSpace（不足时reclaimNow）并判定space_check或disk_space，拒绝直接break；:339才调用recording.start。因此**磁盘拒绝不会为这次候选创建一条录制记录**，也不能把任意deleted/fileSize=0行认作“被gate拒绝的新直播”。
- source=pocket48并不只表示实时录制：replay-import.js:139-150为官方回放导入设置同样source，同时有archiveOrigin=official_replay/manualReplayImport。归档合并、删除等也会改变状态/路径/大小，单靠source/status/size不能还原漏录因果。
- setBlocked仅记录状态边缘；:334在空间通过后、recording.start前清空。因此即便后续start失败，仍可先出现“start gate cleared”。
- :367没有startCandidates也清空blocked：可能无直播、候选已经在录、重试时间未到等。清空日志不能证明清理了磁盘，更不能证明已经成功开录。自建 gate-semantics.test.cjs 在磁盘仍0空间时令直播列表变空，观测blocked消失、hasSpace=false、starts=0同时打印cleared，19项补核日志:126-129有证据。
- clearBlocked() :414只在config.enabled=false时生效，含义是操作者关闭自动录制后不再显示“被阻止”告警，不代表存储修复。

## Retention主文件保护与测试盲点

- retention.js:57-64构造主文件归属保护集合，覆盖除deleted/merged外记录的filePath；sweep :104、purge :189、reclaimNow :238均再次按归属排除。故不能仅凭位于 `.official-replays`、被inventory误分类为cache，就断言当前代码会删掉仍在有效记录中拥有的主文件。
- sweep与purge另有verified.mp4文件名保护；reclaimNow依赖归属保护。已deleted或merged记录不在mainFileGuard中，这是明确实现边界，不是“所有历史主文件永不删除”的保证。retention-quota.test.js:86-97明确预期deleted记录残留可清。
- 原 retention-main-file-guard.test.js:123 调用 `purge(root,{force:true})`，但purge函数只接root，不支持force参数；空闲大于reserve就早退，原用例在空间充足机器上可能没有验证到删除分支。
- 补核设置超高reserve/target，使其确实经过低水位路径；4项主文件保护+14项磁盘策略+1项日志语义复现全过。低水位主文件保护本地已核，不据此推断历史线上数据为何消失。

## 功能覆盖与不能保证之处

| 功能域 | 已实际覆盖 | 未被这轮证明 |
|---|---|---|
| 管理员认证 | 密码哈希、session签名、匿名拒绝、记住登录跨进程、撤销/篡改/过期、凭据修改 | 真实部署代理/HTTPS/SameSite组合、真实用户浏览器状态 |
| Pocket48账号/目录 | 签名/请求头、登录错误映射、SMS DTO/限流、成员目录回退、房间状态 | 当前上游可登录性、真实短信、真实Cookie有效性 |
| 直播/回放播放 | 公共DTO脱敏、SSRF/域名/路径限制、HLS重写、RTMP共享relay（mock）、token过期 | 真实CDN、移动浏览器、长时播放/断线及实际带宽 |
| 自动录制 | 20并发配置/优先级、重启claim/重连、磁盘估算/拒绝/回收、真实FFmpeg本地录制 | 多场真实直播持续数小时、磁盘耗尽/文件系统突变、当前现场是否有候选 |
| 归档/保留/删除 | 真实媒体合并、手动停止、路径越界、session去重、共享文件保护、低水位主文件保护 | 极端并发/大文件压测、所有历史遗留数据形状、Linux权限/挂载/信号差异 |
| 回放导入/巡检 | 下载资源完整性/恢复/哈希、幂等、元数据回填、数字时间导入；巡检ISO决策 | 巡检数字时间兼容已确认有缺陷；没有实测当前上游与真实自动巡检周期 |
| B站 | mock/回环上传分片、备端点、草稿/队列/去重/凭据等待 | 真账号、真实远端上传/投稿/审核、超大文件 |
| 115备份 | JS服务/租约/路由，Python FakeClient 30项，路径/哈希/SDK隔离/协议 | 真实115认证/配额/网络/SDK上传，真实Linux生产Python环境 |
| 字幕/AI | 真实音频提取与mock ASR失败恢复；并行限流/重试/租约/跨进程；纠错/翻译/章节/证据/多格式导出/OSS mock | 模型真实质量、真实额度/限流、外部OSS可用性；未下载或运行离线Whisper真实模型 |
| 封面 | 系统Python真实布局/色边、空白视频模板、保存/同步/删除路由及优先级单元逻辑 | 真实人脸优选用例因未提供样本跳过 |
| 社交/房间音频 | mock社交资料/权限/访问码；房间音频历史读取及真实音频归档 | 真实社交外部会话、长时消息采集、已退役录制功能重新启用 |
| DDTalks | 应用路由与管理认证外围；共享优雅关闭单测 | 缺完整真实会议录制端到端测试；Windows不能代表Linux Xvfb/Chrome音画捕捉 |

这是测试用例层面的覆盖清单，没有运行V8行/分支覆盖率采集，不能给出可信“全部函数覆盖百分比”。没有做真实生产/外部服务端到端写操作，没有证明部署可达性或前端产物与源码一致。

## 证据索引

主要结论：本报告；server-configured.tap；targeted-rerun.tap；python-worker.log.utf8；gate-retention-forced.tap；replay-time.tap；version-details.json。初始异常与环境缺口：server-full.tap.utf8、server-full-run2.tap.utf8。test-inventory.json记录完整选择范围；media-tools.txt记录项目媒体工具版本。所有后台测试任务均已收集完成，没有留下需要持续运行的测试服务。
