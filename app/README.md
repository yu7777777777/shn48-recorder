# 48tools 2.0.0

48tools 2.0.0 是一个私有部署的直播录播中枢：公开页面展示当前直播和口袋48官方成员重播；管理员登录后才能使用本地录制、归档、B站上传、系统配置和账户安全功能。

当前 MVP 的主链路是：

```text
口袋48直播发现 → 网页实时播放 → 录制 → 归档 → B站草稿
```

录像结束后不会立即把临时断流当成一场新直播：同一成员、同一直播主题在默认 5 分钟内恢复时，系统会把片段自动合并为一个 MP4。归档名称、MP4 文件名和 B站草稿标题统一使用 `日期-名字-直播主题`；例如 `2026-09-02-成员一-周年快乐`。MP4 会核验时长并完整解码检查；参数不同的片段先统一画面和音轨。原始 FLV 保留以便恢复，会额外占用磁盘空间；失败时可在录像归档页重试。等待窗口可通过 `RECORDING_MERGE_WINDOW_MS` 调整。

原始 FLV 与官方回放缓存由**磁盘水位清理**回收：剩余空间低于 `STORAGE_RESERVE_GIB`（默认 8 GiB）时开始清理，回到 `STORAGE_TARGET_GIB`（默认 12 GiB）以上停止。可回收的是保留的原始片段、已删除归档的残留和未关联归档的游离文件；**归档主文件 MP4 永不自动删除**，只能在归档列表中手动清理。正在录制、合并或上传的文件一律跳过；主文件校验失败时其原始片段视为最后一份完整副本而保留。

**2.0.0 功能精简**：移除 AI/分析线（ASR 字幕、AI 总结、弹幕高能、字幕搜索、AI 封面、高光切片、投稿文案、公开日报）、通知推送系统、剪辑工作台与转码导出、DDTalks 与房间语音。归档操作（封面、下载、恢复、投稿）全部在归档列表页完成。历史变更见 [CHANGELOG](CHANGELOG.md)。

**版本更新检测**（`/admin/update`）：定时比对 GitHub 仓库发布版本与运行版本，结果在页面状态卡展示（通知系统已移除，不再主动推送）；公开仓库无需任何 Token，「立即检查」可手动验证。更新仍由人工确认后在服务器执行发布脚本，检测为纯只读、失败不影响主链路。

1.14.4 优化录像归档版式：封面与标题突出展示，状态、文件信息和操作分层排列，窄屏无需横向滚动即可操作。

1.31.0 含一处性能修复和一处归档缺陷修复，不含新功能。

性能：公开落地页首屏体积从 1036.2 KB 降至 303.5 KB（−71%）。原因是 `components/VideoPlayer.jsx` 在模块顶层静态引入 `hls.js`（579.2 KB）与 `flv.js`（152.5 KB），而该组件被 5 个页面静态引用，导致只显示直播列表的落地页也下载全部播放器代码；现改为按需动态引入，仅在真正开始播放时加载。这个改动有一个必须记住的约束：`import("flv.js")` 的结果**不能再取 `.default`**。`flv.js` 是 CommonJS 包，vite 在构建期自动注入 `.then(e => e.f)` 完成解包并直接返回库对象，再取 `.default` 会得到 `undefined`，FLV 播放报错但**页面与接口均无任何提示**（静默失败）。

归档去重：同一场直播此前可能被存档成两份（同成员、同主题出现两条已归档记录）。原因是录制去重只认**仍在运行的 ffmpeg 进程**，`manager.addRecording()` 没有按 `liveId` 的场次级判断；服务重启、重连次数耗尽、手动与自动录制混用、断流间隔超过合并窗口时，同一场直播的后续分段会被当成新归档。现在 `manager.addRecording()` 对同一 `liveId` 只保留一个场次属主，后续启动一律写入该场次的**分段**（`segment`/`sessionId`），归档处理器据此合并；`pocket48/recorder.js` 另加启动占位表消除了并发双开窗口。修复只阻止新增重复，已经存在的两条 `done` 归档仍需在归档列表里手动删除多余的一条。

### 自动录制 MVP

管理后台 `/admin/auto-record` 可选择成员并启用自动录制。配置与状态使用 `GET/PUT /api/admin/pocket48/auto-recording`，可用 `POST /api/admin/pocket48/auto-recording/poll` 手动触发轮询。首次配置默认同时录制 20 场，允许范围为 1–20 场；磁盘低于 10 GiB 时不启动新任务。录制结束并完成断流片段合并与 MP4 归档后，系统自动以 draft 模式进入 B 站上传队列，队列单并发。配置和去重状态持久化，服务重启及管理员凭据恢复不会丢失。实际并发能力仍取决于直播码率、CPU、磁盘和带宽。

## 安全边界

系统共用一个 Node 服务，但接口严格分层：

- `/api/public/*`：只读的直播、官方成员重播及受控播放接口，无需登录；这里的重播不是本地录像归档。
- `/api/admin/auth/*`：管理员登录、退出、会话检查和凭据修改；其中改密接口仍会显式验证管理员会话与当前密码。
- 其他 `/api/admin/*`：必须由后端验证管理员会话。
- `/api/public/streams/:token`：后端签发的短期受控流；HLS 清单里的分片和密钥也会换成独立 token，客户端不能提交任意上游 URL。
- `/api/public/relays/:token/{index.m3u8|segment_######.ts}`：口袋48返回 RTMP 时，由服务端共享 FFmpeg 进程转封装为同源 HLS；仅接受 opaque token 和固定文件名，不暴露签名 RTMP 地址。
- `/api/public/replay-streams/:sessionToken/{manifest|resource/:childToken}`：官方 VOD HLS 使用按重播复用的有界会话；清单、密钥和分片使用绑定会话、由已验证清单登记的资源目录及过期时间的 opaque token，不为每个分片保存一条服务端记录；子 token 只接受无 padding、无空白且可规范往返的 base64url，绝对到期毫秒当刻即失效。

前端隐藏按钮不构成权限控制。录像路径、B站 Cookie、口袋48凭据、服务器信息和录制状态都不得从公开接口返回。

建议使用两个域名：

- `live.example.com`：公开直播站，反向代理层直接拒绝 `/admin` 和 `/api/admin/*`。
- `admin.example.com`：管理后台，建议再叠加 VPN、零信任或 IP 白名单。

[Nginx 双域名示例](docs/nginx.conf.example)仅供参考，部署前必须替换域名和证书路径。后端认证仍然是最终安全边界。

## 目录与持久化

```text
app/
├── client/                    React/Vite 公开站与管理后台
├── server/                    Express API、录制与上传模块
├── config/                    YAML 配置模板及运行配置
├── runtime/
│   ├── data/                  状态、封面、口袋48凭据及改密后的管理员凭据哈希
│   ├── recordings/            录像归档
│   └── biliup/                B站扫码凭据（cookies.json）
├── scripts/
│   ├── generate-lockfiles.mjs 生成 npm 锁文件
│   └── smoke-test.mjs         无外部账号的本地冒烟测试
├── Dockerfile
├── docker-compose.yml         生产基础配置，不发布宿主机端口
├── docker-compose.local.yml   本地联调覆盖，绑定 127.0.0.1
└── docker-compose.public.yml  仅用于经明确授权的临时公网验收
```

`runtime/` 和 `.env` 已被 Git 忽略。备份时应分别处理录像、运行状态和 B站凭据；`runtime/data/admin-credentials.json` 与 B站凭据都属于敏感信息，权限应限制为仅服务账号可读。

## 管理员账户安全

勾选「记住登录（30 天）」后，会话摘要保存于持久化数据目录，更新或重建容器后继续有效；退出、过期、改密或修改会话密钥仍会撤销登录。旧版本已失效的会话无法恢复，升级后需重新登录一次。详见[记住登录说明](docs/remembered-login.md)。

登录后台后可从“账户安全”（`/admin/security`）修改管理员账号和密码。前端调用：

```http
PUT /api/admin/auth/credentials
Content-Type: application/json

{ "currentPassword": "...", "newUsername": "...", "newPassword": "..." }
```

接口要求有效管理员会话并再次验证当前密码。`newUsername` 与 `newPassword` 至少提供一个；新用户名要求 3–64 个字符且不能包含空白，新密码要求 10–256 个字符、至少包含小写字母/大写字母/数字/符号中的两类，并且不能与用户名或当前密码相同。修改成功后全部管理员会话立即失效，页面会回到登录页。

环境变量中的 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 只作为首次启动和旧部署兼容的初始凭据。首次在页面改密后，系统会将用户名、随机盐和 `scrypt` 哈希原子写入 `runtime/data/admin-credentials.json`（权限 `0600`），此文件优先于环境变量且不含明文密码。不要手工编辑、删除、提交或放进部署包；重建容器时必须保留 `runtime/data` 挂载。

## 部署前要求

- Node.js 20 或 Docker Engine + Docker Compose v2。
- ffmpeg；Docker 镜像内已包含。
- 口袋48接口需要稳定的中国大陆网络出口。境外服务器可能无法访问、延迟较高或触发风控。
- 管理员强密码和至少 32 字节的随机 `SESSION_SECRET`。
- 公网部署必须使用 HTTPS 反向代理，不能直接暴露 Node 的 3000 端口。
- 确认服务器有足够的磁盘空间和持续写入能力。
- 扫码并测试 B站账号后，确认 `runtime/biliup/cookies.json` 在重建容器后仍存在。

Docker 构建默认使用阿里云 Debian 镜像和 npmmirror，以适配中国大陆服务器。apt 使用 HTTP 传输，但 Release 元数据仍由 Debian 的 GPG 签名校验；这是为了兼容尚未安装 CA 证书的 slim 基础镜像。境外服务器可在 `.env` 中切回官方源：

```dotenv
DEBIAN_MIRROR=http://deb.debian.org/debian
NPM_REGISTRY=https://registry.npmjs.org
```

仓库已提交 `client/package-lock.json` 和 `server/package-lock.json`，Docker 与正式部署统一使用 `npm ci`，确保依赖解析可复现。更新依赖清单后可执行：

```bash
node scripts/generate-lockfiles.mjs
```

检查并提交两个锁文件；不得再混用 pnpm 锁文件或在正式构建中回退到 `npm install`。

## Docker 本地联调

先复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

填写 `.env` 中的三个必填项：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=填写独立强密码
SESSION_SECRET=填写至少32字节随机值
```

修改后重新创建容器即可生效：

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate
```

启动本地版本：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.local.yml ps
```

浏览器访问 `http://127.0.0.1:3000`。本地覆盖文件只监听回环地址，不会向局域网开放。

停止服务但保留数据：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

不要随意给 `down` 添加 `-v`，也不要删除 `runtime/`；这会影响状态、录像、管理员登录或B站凭据。

## 生产部署

基础 `docker-compose.yml` 只有 `expose: 3000`，不会把端口发布到宿主机。推荐让 Nginx、Caddy 或 Traefik 容器加入 `shn48-web` 网络，并代理到 `shn48:3000`：

```bash
docker compose up -d --build
```

如果必须使用宿主机上的反向代理，可参考本地覆盖方式将端口只绑定到 `127.0.0.1`，绝不能绑定为 `0.0.0.0:3000`。TLS、域名和限流配置在确定服务器后再落地。

`docker-compose.public.yml` 只是短期验收覆盖：它会把 HTTP 3000 直接暴露到公网，并因无 TLS 关闭安全 Cookie。只能在明确授权、强随机临时密码和完整 smoke test 的受控验收期使用；对外开放前必须撤掉该覆盖，改用 HTTPS 反向代理并恢复 `COOKIE_SECURE=true`。

正式部署入口仅为 Docker Compose；发布包不包含旧式直跑 Node 部署脚本。

## 手动开发

后端：

```bash
cd server
npm install
npm run dev
```

前端：

```bash
cd client
npm install
npm run dev
```

生成锁文件后改用 `npm ci`。开发环境也必须设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 和 `SESSION_SECRET`，不要在源码或 YAML 中写真实密码。

## 冒烟测试

测试不需要口袋48或B站账号，只使用测试环境配置的本地管理员。先让服务使用同一组管理员环境变量启动，再执行：

```powershell
$env:SMOKE_BASE_URL = "http://127.0.0.1:3000"
$env:SMOKE_ADMIN_USERNAME = "admin"
$env:SMOKE_ADMIN_PASSWORD = "与服务端测试环境相同的密码"
node scripts/smoke-test.mjs
```

脚本验证：

1. `/api/public/health` 和 `/api/public/live` 可匿名访问并返回 JSON。
2. 未登录访问管理录制接口返回 `401`。
3. 旧的 `/api/stream/proxy?url=...` 任意 URL 代理返回 `404` 或 `410`。
4. 管理员登录返回会话 Cookie，session 为已登录状态。
5. 携带 Cookie 可访问受保护接口，退出成功。

完整 API 冒烟契约还包括以下人工/集成测试项：

- `GET /api/public/live/:liveId` 获取直播详情。
- `GET /api/public/live/:liveId/play` 按后台策略返回播放地址：默认 HTTP FLV/HLS 直连并在失败时以 `?fallback=server` 重新申请服务器代理；后台切换为服务器中转时直接返回 opaque `playUrl`。RTMP 始终由服务器 relay。
- `GET /api/public/streams/:token` 只代理服务端签发的直播源；HLS 分片使用各自的 opaque token。
- RTMP 直播的 `playUrl` 指向 `/api/public/relays/:token/index.m3u8`；同一 Node 进程内相同 `liveId` 复用一个 FFmpeg relay。
- `GET /api/public/replays?next=&groupId=&userId=` 返回官方成员重播列表和字符串分页游标；`groupId` 与 `userId` 不能同时提交。
- `GET /api/public/replays/:liveId` 返回脱敏官方重播详情；不返回本地归档、录像路径或上游 VOD URL。
- `GET /api/public/replays/:liveId/play` 仅为确认的 HTTPS HLS 返回 `protocol: "hls"` 和 opaque 同源 `playUrl`；当前不支持 MP4/RTMP 重播，也不会为重播启动 FFmpeg。
- `POST /api/public/replays/:liveId/download` 启动或复用官方回放的完整下载与校验；`GET /api/public/replays/:liveId/download/status` 查看准备进度；准备完成后 `GET /api/public/replays/:liveId/download` 返回校验通过的 MP4 文件。
- `POST /api/admin/pocket48/recordings/start` 使用 `{ "liveId": "..." }` 启动录制。
- `GET /api/admin/pocket48/recordings/active` 查看活动任务。
- `POST /api/admin/pocket48/recordings/:recordingId/stop` 停止录制并进入归档。
- `POST /api/admin/recordings/:id/upload` 把归档加入B站草稿上传队列。
- `GET /api/admin/bilibili/account` 通过 B站 `nav` 实时核验账号，只返回 `loggedIn/authenticated/credentialsPresent/health/upstreamAvailable/stale/mid/uname/face/level/vipStatus/lastCheckedAt/lastSuccessfulAt`；`health` 为 `ok`、`not_logged_in`、`unavailable` 或 `credentials_error`，临时上游失败不会删除 Cookie。
- `GET /api/admin/bilibili/queue` 兼容返回 `data` 数组，并在顶层 `summary` 给出 `total/queued/uploading/failed/done`；队列项只有卡片所需字段，不返回本地文件路径。
- `GET /api/admin/bilibili/drafts` 成功时返回脱敏草稿卡片数组和分页摘要，不返回原始上游对象；B站草稿列表上游 404、鉴权失败或响应结构变化时明确返回 `502`，不会伪装成空草稿箱。
- `PUT /api/admin/auth/credentials` 必须携带有效会话并验证当前密码；成功后新凭据可在容器重建后继续使用，原有全部会话失效。

B站工作台页面已按上述契约重构：账号健康、队列统计和草稿可用性分别呈现，草稿上游失败时保留账号与队列内容并提供独立重试。

## 带宽与播放策略

公开播放优先让浏览器使用可播放的 HTTP(S) 上游；口袋48返回 RTMP 时，服务端会用 FFmpeg 转封装为 HLS。前端收到 HLS 后在 `Hls.isSupported()` 时优先使用 hls.js，只有 hls.js 不可用且浏览器声明支持 HLS 时才回退原生 `<video>`（主要覆盖 iOS/Safari），避免 Chromium 误报原生支持后直接加载 manifest 失败。同一 `liveId` 在单个 Node 进程内共享一个 relay，不会为每位观众重复启动 FFmpeg；但所有观众仍从服务器下载 HLS，出口带宽会随观看人数线性增长：单路 2 Mbps 直播在 50 人同时观看时约需 100 Mbps 出口，尚未计入协议和峰值开销。

Relay 分片默认写入系统临时目录，直播结束、启动失败、服务退出或持续无访问时会自动终止 FFmpeg 并清理文件。生产环境必须确保 FFmpeg 可执行、临时目录可写且容量受控；Compose 已将 `/tmp` 配置为 1 GiB tmpfs。多实例部署时 relay 只在各 Node 进程内复用，如需跨实例共享应增加外部协调和统一流媒体层。

官方成员重播是 Pocket48 VOD，不属于管理员本地归档。后端默认只接受 `idol-vod.48.cn` 的 HTTPS HLS；入口目录和已验证清单实际引用的资源目录会登记到单个 session，最多 64 个，客户端仍不能提交 URL 或把 token 改成其他资源。会话按重播复用、活跃期滑动，绝对期限按已知时长加缓冲计算且最长 6 小时。当前后端 `node:test` 为 22/22、前端播放器选择逻辑 `node:test` 为 3/3，Vite production build 通过；真实 CDN、协议或浏览器能力变化后仍需重新验收。

生产环境应配置：

- 流接口并发限制、连接超时和基础防滥用。
- HLS 分片短时缓存；不要缓存管理接口或认证响应。
- 磁盘容量告警、录像保留策略和失败任务告警。
- 公开站与录制任务解耦，任何一侧失败都不应停止另一侧。

## 上线前检查清单

- [ ] `.env` 不在版本控制中，密码与 Session 密钥已更换。
- [ ] Node 3000 未直接暴露公网，HTTPS 证书有效。
- [ ] 公开域名无法访问管理页面和管理 API。
- [ ] 所有 `/api/admin/*`（认证接口除外）未登录均返回 `401`。
- [ ] 任意 URL 代理已移除，受控流 token 有过期时间与来源白名单。
- [ ] 录像、数据、配置和B站凭据在容器重建后仍存在。
- [ ] 修改管理员账号密码后旧会话失效，新凭据可登录；重建容器后仍可使用新凭据。
- [ ] 口袋48接口在目标服务器网络可用。
- [ ] B站扫码、上传与草稿可用，默认不自动公开发布。
- [ ] smoke test 全部通过，并完成一次真实“播放→录制→归档→草稿”验收。
