# 发布流程与线上核验报告

- 审查日期：2026-10-14（Asia/Shanghai）
- 审查类型：**只读核对**（未执行任何写操作、容器启停、删除、prune、部署）
- 审查基准：`AGENTS.md` + `1.0.2/docs/release-process.md`
- 工作目录：`D:\飞牛同步\AI资料库\AI项目空间\shn48录制`（**注意：任务书给出的 `C:\Users\Administrator\Desktop\shn48` 不存在，已改用实际路径**）
- 线上节点：阿里云 `<SERVER_IP>`，服务器 ID `425820f3-34ff-4765-9106-c329bbac8246`（现场从 `list_servers` 重新确认，未使用历史 ID）
- 审查工具：本地文件读取 + `dstatus` MCP 远程命令（`list_servers` / `run_remote_command`），全部命令均为只读

---

## 总体判断（5 行内）

1. **版本一致性与线上实际状态高度干净**：7 处版本位置全部为 `1.17.5`，本地 254 项 + 135 项哈希清单、容器内 135 项运行时哈希**全部逐字节匹配，0 不匹配**。
2. **线上生产健康且合规**：`shn48-recorder` healthy、镜像标签 1.17.5、公开健康接口版本一致、未认证管理接口 401、Compose 正确加载公开覆盖档、`version.mjs check` 的校验范围**覆盖全部版本位置**。
3. **无阻断级问题**：未发现版本漂移、产物被改、错误部署或生产不一致。
4. **主要缺陷集中在"记录与卫生"**：`docs/releases/` 有 **9 个已发布版本缺少审计记录**（1.16.0–1.16.4、1.17.0–1.17.2）；`CHANGELOG` 的 1.17.5 段落存在重复条目、Unreleased 含占位句未清空。
5. **两处需尽快处理**：**（高）明文 root 密码 `阿里云服务器.txt` + 3 个可用 SSH 脚本未被忽略，且位于"飞牛同步"同步盘目录**；**（中）生产磁盘 `/` 已用 80%（剩 7.7G），62 个镜像中 3.69GB/99% 可回收**。

---

## 本地一致性核对结果（逐项）

### 1. 版本号 7 处逐一比对 → **全部一致 = 1.17.5** ✅

| # | 文件 | 提取方式 | 值 | 结论 |
|---|---|---|---|---|
| 1 | `1.0.2/VERSION` | 文件全文 | `1.17.5` | ✅ |
| 2 | `1.0.2/client/package.json` | `"version"` 字段 | `"1.17.5"` | ✅ |
| 3 | `1.0.2/server/package.json` | `"version"` 字段 | `"1.17.5"` | ✅ |
| 4 | `1.0.2/docker-compose.yml` | `image: shn48-shn48:1.17.5`（第 5 行） | `1.17.5` | ✅ |
| 5 | 根 `README.md` | 第 3 行"当前正式版本：**1.17.5**" + 发布表首行 | `1.17.5` | ✅ |
| 6 | `1.0.2/README.md` | 第 1、3 行"48tools **1.17.5**" | `1.17.5` | ✅ |
| 7 | `1.0.2/CHANGELOG.md` | 含 `## [1.17.5] - 2026-10-11` 段落 | `1.17.5` | ✅ |

补充：`Dockerfile` 的 `org.opencontainers.image.version="1.17.5"`、`Dockerfile.release` 的 `revision="release-1.17.5-20261011"`、`scripts/smoke-test.mjs` 断言 `version === "1.17.5"` 也一致。

**未发现任何版本不一致。** 全仓库扫描非 1.17.5 的 `1.17.x/1.16.x` 字样仅出现在：CHANGELOG 历史段落、`docs/releases` 审计记录，以及 `package-lock.json` 中的第三方依赖版本（`follow-redirects 1.16.0`、`serve-static 1.16.3`）——**均为正常，非版本漂移**。

### 2. 哈希清单校验 → **见下节专章（全部匹配）**

### 3. `scripts/` 脚本实际职责

| 脚本 | 实际行为 |
|---|---|
| `version.mjs` | **`set X.Y.Z`**：校验 `X.Y.Z` 格式与必须递增，然后全量 `replaceAll(current, next)` 写入 13 个文本文件（Dockerfile、Dockerfile.release、README.md、client/index.html、App.css、AdminLayout.jsx、PublicLive.jsx、PublicReplay.jsx、server/index.js、server/routes/public.js、members.js、smoke-test.mjs、docker-compose.yml），并改写 `client`/`server` 的 `package.json`+`package-lock.json` 的 `version`、`packages[""].version`、`description`，最后写 `VERSION`。<br>**`check`**：反向校验上述 4 个 manifest 字段 + 13 个文本文件含当前版本 + `CHANGELOG.md` 含 `## [current]`。 |
| `manifest.mjs` | 递归遍历维护目录，排除 `node_modules/.git/runtime/release/__pycache__/*.pyc(pyc)/.env*(保留 .env.example)/config/config.yaml/SHA256SUMS/RUNTIME-SHA256SUMS/docs/releases/**/*.log`，遇符号链接**直接抛错**；生成 `SHA256SUMS`（全量）与 `RUNTIME-SHA256SUMS`（仅 `server/**` + `client/dist/**` + `VERSION`）。脚本提示 `entrypoint.sh` 需在 `/entrypoint.sh` 单独校验。 |
| `archive-backfill.cjs` | 归档回填工具。默认"预演"模式，要求显式 `DATA_DIR` + `BACKFILL_RESULT` + 显式录像 ID；`--apply` 时逐条校验 `status==='done'` 且 `filePath===originalPath` 未变、目标 MP4 存在，用 `wx` 独占标志写临时文件后 `renameSync` 原子替换。**带前置一致性保护，设计谨慎。** |
| `generate-lockfiles.mjs` | 在 `client`/`server` 下执行 `npm install --package-lock-only --ignore-scripts`，生成 lockfile。 |
| `smoke-test.mjs` | 冒烟测试：健康接口 200 且 `version===1.17.5`、公开直播列表、**未认证管理接口必须 401**、**已废弃 `/api/stream/proxy` 必须 404/410**；若提供管理员凭据则再验证登录→会话→受保护端点→登出。 |

> **`version.mjs check` 的覆盖范围结论**：覆盖 manifest（client/server 各 2 个文件）、13 个文本文件、CHANGELOG。**但它不检查 `docker-compose.public.yml` / `docker-compose.local.yml` / `1.0.2/README.md` / 根 `README.md` 独立版本号**——本次这几处恰好都正确（根 README 与 1.0.2/README.md 由人工维护，compose overlay 不含版本号），属**覆盖边界偏窄**的中低风险，非当前缺陷。
> ⚠️ 同时：`version.mjs` 依赖 `client/index.html`、`server/index.js` 等文件**含版本字符串**；若某文件被移除，`check` 会因读文件失败而报错（fail-closed，行为安全）。

### 4. `CHANGELOG.md` 的 Unreleased 与 1.17.5 段落 → **均有问题**

- **Unreleased 非空但为占位句**（第 3–5 行）：
  ```
  ## [Unreleased]

  - 下一轮未发布变更待记录。
  ```
  → 违反"发布前将 Unreleased 整理为带日期版本条目"的精神，属**残留占位符未清空**。

- **1.17.5 段落存在真实重复条目**（第 9–19 行）。第 9–10 行与第 12 行内容实质重复：
  - 第 9 行：`管理端侧边栏按工作台、内容工具和系统分组，增强当前导航反馈、版本在线状态和移动端菜单布局。`
  - 第 10 行：`总览卡片、页面背景与同步状态层级统一，提升信息扫描效率。`
  - 第 12 行：`管理端体验与前端视觉优化：侧边栏按工作台…；总览卡片、页面背景与同步状态层级统一，提升信息扫描效率。`
  → 第 12 行是**第 9+10 行的合并版**，三者并存；且第 11 行为空行导致列表断裂。**确认非编码问题**（已用 UTF-8 读取并验证无 BOM 干扰）。

### 5. `docs/releases/` 覆盖缺口 → **9 个已发布版本无审计记录**

- 已有 `*-audit.md` 版本集合（33 个）：`1.0.2, 1.1.0, 1.1.1, 1.2.0, 1.2.1, 1.3.0, 1.3.1, 1.3.2, 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.9.0, 1.9.1, 1.9.2, 1.10.0, 1.10.1, 1.11.0, 1.11.1, 1.12.0, 1.13.0, 1.13.1, 1.13.2, 1.14.0, 1.14.1, 1.14.2, 1.14.3, 1.14.4, 1.15.0, 1.15.1, 1.17.3, 1.17.4, 1.17.5`
- CHANGELOG 版本集合为 46 个。
- **完全缺失审计记录（9 个）**：`1.16.0, 1.16.1, 1.16.2, 1.16.3, 1.16.4, 1.17.0, 1.17.1, 1.17.2`
- 另有历史小缺口：`1.0.1, 1.0.0, 1.8.0, 1.12.1`（根 README 已如实标注 `—`，`1.0.0/1.0.1` 明确说明"无法可靠追溯"——**这种诚实标注值得肯定**）。
- 根 `README.md` 发布表中上述 9 行"记录"列均为 `—`，**README 与 docs 一致地反映了缺口**（说明是"确实没写"，而非"写了没链接"）。
- ⚠️ **`1.9.0`, `1.9.1`, `1.9.2`, `1.7.0` 等 audit.md 中引用了 `DStatus` 部署到阿里云**，但对应版本的本地审计文件存在而 1.16.x 整段缺失，说明**审计记录纪律在 2026-09-30 的密集发布期（当天连发 1.16.0→1.17.2 共 10 个版本）被打破**。

### 6. Compose / Dockerfile / entrypoint 与文档描述一致性 → **一致，且实测与生产吻合**

| 项 | 实际内容 | 与纪律/文档一致性 |
|---|---|---|
| `docker-compose.yml` | `image: shn48-shn48:1.17.5`、`container_name: shn48-recorder`、`restart: unless-stopped`、**`expose: 3000`（无 ports）**、4 个卷挂载（`config`/`data`/`recordings`/`biliup`）、`tmpfs /tmp:exec,size=1g`、`healthcheck` 用 `node -e fetch(/api/public/health)`、`networks: web`、3 个必填环境变量用 `${VAR:?}` 强制（`ADMIN_USERNAME/ADMIN_PASSWORD/SESSION_SECRET`） | ✅ 设计正确：基础档**不暴露端口** |
| `docker-compose.public.yml` | 仅做三件事：`COOKIE_SECURE=false`、`TRUST_PROXY=false`、`ports: ${HOST_IP:-0.0.0.0}:${HOST_PORT:-3000}:3000`；注释明确写"临时服务器测试用，正式应换 TLS 反代" | ✅ 覆盖档职责清晰；**端口映射只在此档**，符合"公开部署需同时加载两个文件" |
| `docker-compose.local.yml` | `container_name` 可覆盖、`COOKIE_SECURE=false`、`TRUST_PROXY=false`、`ports: 127.0.0.1:3000:3000`（**仅回环**）；有注释说明生产应走 TLS 反代 | ✅ 本地诊断隔离正确 |
| `Dockerfile` | 多阶段；`LABEL org.opencontainers.image.version="1.17.5"`；Debian 镜像源 + NPM registry 可覆盖；安装 ffmpeg/xvfb/chromium/tini/中文字体；`faster-whisper==1.2.1` + cover-requirements；`COPY VERSION /app/VERSION`；`HEALTHCHECK` 与 compose 一致；`ENTRYPOINT ["/entrypoint.sh"]` | ✅ |
| `Dockerfile.release` | 复用 `shn48-asr-runtime:1.2.1` 基底，**先 `RUN test -x /opt/asr-venv/bin/python && python -c "import cv2; from PIL import Image"` 做基底完整性前置校验**；额外打 `revision` 标签；不重装依赖 | ✅ 与 `release-process.md` 第 5 条一致；**前置校验正是为了防"缺 cv2"类问题** |
| `entrypoint.sh` | `set -eu`；首启时从 `/app/config-defaults/config.example.yaml` 初始化 `config.yaml`；`ENABLE_XVFB=1` 才起 Xvfb，**Xvfb 失败仅告警不阻断主服务**（20 次 0.1s 轮询后 kill）；`exec /usr/bin/tini -g -- node index.js` | ✅ 与注释"DDTalks 非 MVP，失败不得影响主服务"一致 |

**线上实测交叉验证（关键）**：
```
com.docker.compose.project.config_files = docker-compose.yml,docker-compose.public.yml   ✅ 符合纪律
容器挂载：/opt/shn48/config→/app/config, /opt/shn48/runtime/{data,recordings,biliup}→对应
宿主机监听：0.0.0.0:3000 (docker-proxy) + 0.0.0.0:22 (sshd)   ✅ 与 public 档端口映射吻合
```
> ⚠️ 附带发现：public 档将 `COOKIE_SECURE=false` 且明文 HTTP 暴露（`http://<SERVER_IP>:3000`），注释已自我声明为"临时测试"。**当前管理端会话 Cookie 在公网明文传输**，属已披露但未闭环的安全债（详见中优先级）。

### 7. 版本档案与根目录杂乱度

- **`/opt/shn48/releases/1.17.5/pre-deploy/` 线上真实存在**：含 `docker-compose.yml`(2511B)、`docker-compose.public.yml`(313B)、`VERSION`(7B)。`1.17.5-audit.md` 第 42 行的描述与线上实际**完全吻合** ✅
- **本地无对应记录**：本地不存在 `releases/` 档案目录（仅有 `1.0.2/docs/releases/` 文档目录与 `1.0.2/release/` 补丁目录）。本地 `docs/` 中有描述该路径的文档，但**本地不留存副本**——这本身可接受（档案是生产侧职责），但**意味着本地无法离线复核回滚材料**，属记录不闭合。
- **根目录 7 个归档/中间包（合计 ~10.5MB）**，均**不在** `SHA256SUMS` 清单范围内（因不在维护目录内）：
  | 文件 | 大小 | 性质 |
  |---|---|---|
  | `deploy-1.17.0.tar.gz` | 6,334,694 B | ⚠️ **含 `server/node_modules/` 全量依赖**（见下），体积最大的杂乱源 |
  | `deploy-clean-1.17.2.tar.gz` | 2,052,762 B | 干净部署包（含 `.env.example`，**无** `.env`） |
  | `deploy-clean-1.17.1.tar.gz` | 1,056,951 B | 同上 |
  | `deploy-clean-1.17.0.tar.gz` | 1,052,423 B | 同上 |
  | `deploy-js.gz` | 361,479 B | 中间产物，无说明 |
  | `front-src-1.17.0.tar.gz` | 125,097 B | 前端源码归档（**AGENTS.md 要求保留的历史源码归档**） |
  | `package-meta-1.17.0.tar.gz` | 28,530 B | 中间产物，无说明 |
- **额外杂乱**：`backend-out.txt`(5KB 日志)、`_debug/`(含完整重复的 `.tools/cover-venv` 与 `1.0.2` 影子目录)、`1.0.2/release/chunk_0000..0106.txt`(107 个 12KB 分片，合计 ~1.28MB，系 base64 分片传输残留)、`1.0.2/release/*.b64`、`.tools/*.b64`。
- **遵守情况**：`front-src-1.17.0.tar.gz` 与 `deploy-clean-*` 属"历史源码归档"，`AGENTS.md` 要求保留 → **不应删除**；`deploy-js.gz`、`package-meta-1.17.0.tar.gz`、`backend-out.txt`、`chunk_*.txt` 属明确中间产物 → 可清理。**当前无任何清理/归档计划文档**（`docs/` 中未见）。
- ⚠️ **`deploy-1.17.0.tar.gz` 内含 `server/node_modules/`**，与 `AGENTS.md`"不将 node_modules 放入源码发布包"**直接冲突**。虽为历史包，但作为"可保留归档"留存，存在体积与复用风险（后人若误用它作部署基线会带入过期依赖）。

### 8. 凭据泄漏风险 → **发现 1 条明确泄漏链（高）**

| 检查项 | 结论 |
|---|---|
| `1.0.2/.env.example` | ✅ **安全**：`ADMIN_PASSWORD=`、`SESSION_SECRET=`、`TYPESAFE_API_KEY=` 均为空值，仅含说明注释与默认镜像源。**可安全入库**。<br>⚠️ 但发现**乱码缺陷**：第 24 行范围注释为 `# 鍚屼竴鎴愬憳…`（GBK 被按 UTF-8 解码的乱码），该行本应为中文说明。**读者无法辨认**，属低优先级但应修复的质量问题。 |
| `1.0.2/.gitignore` | ⚠️ 忽略了 `.env`、`runtime/`、`node_modules`、`client/dist/`、`config/config.yaml`、`*.log` —— **但未忽略 `阿里云服务器.txt`、`ssh_stage*.py`、`backend-out.txt`** |
| `1.0.2/.dockerignore` | ✅ 忽略 `.env`、`.git/`、`runtime/`、`node_modules*`、`*.log`、`**/__pycache__/`；**刻意保留 `client/dist`** 供 `Dockerfile.release` 使用（有注释说明）——设计正确 |
| **`阿里云服务器.txt`** | 🔴 **疑似含明文服务器凭据且未被忽略**。文件 71 字节，位于**根目录且不在任何 ignore 规则内**。经正则模式验证 **含 `密码：`/`密码:` 字段**（这正是 `ssh_stage.py` 提取逻辑所匹配的键）。**按任务要求，我不复述其中任何内容。** |
| **根目录 `ssh_stage*.py`（3 个）** | 🔴 **三个脚本均可直接取得 root 密码并连接生产服务器**。`ssh_stage.py` 内容：读取 `阿里云服务器.txt` → `re.search(r'密码[：:](.+)', text).group(1)` → `paramiko` 连接 `<SERVER_IP>:22`，`username='root'`，**`AutoAddPolicy()`（不校验主机密钥）** → SFTP 上传 + `exec_command` 执行 `rm -rf` 级别的部署命令。`ssh_stage_1171.py` / `ssh_stage_clean.py` 同构。 |
| `.env`（真实） | ✅ 本地维护目录内**不存在** `.env`（仅 `.env.example`）。生产侧 `/opt/shn48/.env` 权限 `-rw-------`（600），另有 3 个 `.env.before-*` 备份同为 600 —— **生产端权限设置正确**。 |

**风险评估**：目录位于 `D:\飞牛同步\...`（**"飞牛同步" = 文件同步盘**）。若该目录正被同步客户端监视，则**明文 root 密码与可直接利用的 SSH 脚本会同步到 NAS/云侧**，攻击面超出本机。这是本次审查中风险最高的发现。

**未发现**的问题：`deploy-clean-*` 与 `deploy-1.17.0.tar.gz` 归档中**均无 `.env`、无 `cookies.json`、无 `config.yaml`**（仅含 `.env.example` 占位）；`阿里云服务器.txt` 与 `ssh_stage*.py` **未被打入任何发布包**。因此**尚未造成"发布包携带凭据"的既成事实**——这点是好消息。

---

## 哈希清单校验结果

### 方式
1. 解析 `SHA256SUMS`（254 条）与 `RUNTIME-SHA256SUMS`（135 条）为 `路径→哈希` 映射；
2. 逐条对磁盘文件重算 SHA-256 比对（**全量，非抽样**）；
3. 反向复现 `manifest.mjs` 的 `walk()` 排除规则，检查**清单覆盖完整性**（防止"文件被新增但未进清单"这一正向校验看不见的漂移）；
4. 将 `RUNTIME-SHA256SUMS` 送入生产容器，对 `/app` 内实际运行文件逐条校验。

### 结果 —— 全部通过 ✅

| 清单 | 条目数 | 匹配 | 缺失 | 不匹配 |
|---|---|---|---|---|
| `1.0.2/SHA256SUMS` | 254 | **254** | 0 | **0** |
| `1.0.2/RUNTIME-SHA256SUMS` | 135 | **135** | 0 | **0** |
| 覆盖完整性（walk 收集 vs 清单） | 254 vs 254 | — | 「磁盘有清单无」0 条；「清单有 walk 无」0 条 | **完全一致** |
| **容器内 `/app` 对 `RUNTIME-SHA256SUMS`** | 135 | **135** | 0 | **0** |

```
# 容器内校验输出（只读）
total=135 mismatches=0
```

### 关于 `client/dist/` 构建产物的专项结论

**你特别关注的点：产物是否被改过而忘更新清单 —— 结论是没有。**

- `client/dist/` 共 **37 个文件，全部 37 个都在 `RUNTIME-SHA256SUMS` 中且哈希逐一匹配**（清单含 37 条 `client/dist/` 条目，磁盘 37 个文件，"清单未覆盖的 dist 文件" 为空集）——**无任何产物游离于清单之外**。
- 构建产物时间戳统一为 **2026-10-11 18:51**（发布当天），与 `1.17.5` 发布日期 `2026-10-11` 一致；`favicon.svg` 为 2026-08-05（长期未变的静态资源，合理）。
- 生产容器内 `/app/client/dist/assets` 有 **35 项资产文件**（=`dist` 内 `assets/` 下的 35 个 `.js/.css`），与本地 `client/dist/assets` 一致；叠加 `dist/index.html` 与 `dist/favicon.svg` 后与本地 37 个文件总数吻合；且 135 项运行时哈希（含全部 37 个 dist 产物）**在容器内 0 不匹配**。
- 关键产物交叉确认：容器内 `client/dist/index.html` = `cbff45e7aa589ec0…`、`server/index.js` = `bff7d9be51dc8498…`、`/app/VERSION` = `06602835753cefc9…`，与本地清单测算一致。

> ⚠️ **一个流程盲点（非缺陷，值得记录）**：`manifest.mjs` 生成的清单**不会被打进镜像**（`Dockerfile` 只 `COPY` server、client/dist、entrypoint.sh、VERSION，不含 `SHA256SUMS`/`RUNTIME-SHA256SUMS`）。因此"核对容器内文件哈希"必须**由宿主机侧的清单副本驱动**（本次即用 `/opt/shn48/releases/1.17.5/RUNTIME-SHA256SUMS`）。这在 `1.17.5-audit.md` 中被正确执行了，但**文档未说明这一依赖**，未来执行者可能误以为镜像内自带清单而在容器内找不到文件、进而误判"清单缺失"。建议在 `release-process.md` 中补一句说明。

---

## 线上实际状态

### 连接方式（符合纪律）
先用 `dstatus` 的 `list_servers` **现场重新确认**服务器列表（共纳管 9 台），从中定位：
```
[ID: 425820f3-34ff-4765-9106-c329bbac8246] 阿里云 (分组: 生产机) | 地址: <SERVER_IP>:22
```
→ **未使用任何历史 ID**（列表中另有美国、日本、澳大利亚等 8 台，均未触碰）。后续全部命令通过 `run_remote_command` 定向此 ID 执行，**全部只读**。

### 容器状态
```
5f30062d93fc | shn48-recorder                  | shn48-shn48:1.17.5 | Up 3 days (healthy) | 2026-10-11 18:59:00 +0800
2a6a2518f94b | shn48-recorder-rollback-1.17.2  | shn48-shn48:1.17.2 | Exited (0) 6 days ago | 2026-09-30 18:47:38 +0800
```
- 运行容器 `shn48-recorder`：**healthy**，`State.StartedAt = 2026-10-11T10:59:01Z` (= 18:59 CST)，与 1.17.5 发布日吻合 ✅
- 与 `1.17.5-audit.md` 声明的"运行容器 healthy"**一致** ✅

### 健康接口
```
本地:  http://<SERVER_IP>:3000/api/public/health  → HTTP 200
       {"success":true,"data":{"status":"ok","version":"1.17.5"}}
容器内: http://127.0.0.1:3000/api/public/health       → {"success":true,"data":{"status":"ok","version":"1.17.5"}}
```
→ **version = 1.17.5，与实际镜像、本地 VERSION 三者一致** ✅

### 未认证访问管理接口
```
admin_anon_http = 401     ✅ 管理与未认证隔离正常
proxy_http      = 404     ✅ 已废弃的任意 URL 代理接口确认不可用（符合 1.17.x 安全修复）
```
与 `smoke-test.mjs` 的两项安全断言**完全对应** ✅

### 镜像版本标签
```json
"org.opencontainers.image.title":"48tools",
"org.opencontainers.image.version":"1.17.5",
"org.opencontainers.image.revision":"release-1.17.5-20261011",
"description":"48tools 1.17.5 - private recording hub with public live playback"
```
→ 标签齐全且与本地 `Dockerfile.release` 一致 ✅

### 容器内 `VERSION` 与本地一致性
```
docker exec shn48-recorder cat /app/VERSION  →  1.17.5     ✅ 与本地 1.0.2/VERSION 一致
```
并已完成**容器内 135 项运行时哈希全量比对：0 不匹配** ✅

### 已停止容器与清理纪律对照
- **唯一**已停止容器：`shn48-recorder-rollback-1.17.2`（`Exited (0)`）。
- `1.17.5-audit.md` 第 38 行明确记录该容器**作为回滚材料保留**，且"删除本次失败构建产生的临时容器 `priceless_wescoff`，未执行无范围清理" —— **现状与记录一致，纪律执行到位** ✅
- **应保留**：`shn48-recorder-rollback-1.17.2`（最近回滚点，1.17.2→1.17.3 曾出问题，见 `1.17.5-audit.md` 提及 rollback 用途）；运行容器 `shn48-recorder`（**绝不可删**）。
- **应清理**：16 个 dangling 镜像（`none:none`）→ 属构建残渣，无回滚价值；以及 1.13 及更早的历史镜像标签（`live-panel-20260913`、`danmaku-fix-20260913`、`rollback-before-1.0.2`…）。**但请务必按纪律人工核对后再定向删除**（`docker rmi` 指定 ID），**禁止 `docker system prune`**。本次审查**未执行任何删除**。

### 磁盘占用
```
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        40G   30G  7.7G  80% /
```
```
/opt/shn48/runtime/recordings   19G      ← 主要占用
/opt/shn48/runtime/data        236M
/opt/shn48/runtime/biliup      8.0K
```
```
docker system df:
TYPE         TOTAL  ACTIVE  SIZE      RECLAIMABLE
Images       62     2       3.72GB    3.694GB (99%)
Containers   2      1       0B        0B
Local Volumes 4     0       0B        0B
Build Cache  0      0       0B        0B
```
单场录像体积（**同一场次同时留存 `.flv` 原片 + `.mp4` 归档**）：
```
2.9G  20261013T141040Z_...熊紫轶...flv
2.9G  2026-10-13-SNH48-熊紫轶-来.mp4
1.6G  20261013T142810Z_...禹佳蔚...flv
1.6G  2026-10-13-SNH48-禹佳蔚-👀想你.mp4
```

**判断**：
- **磁盘 80% 已进入需关注的区间**（剩余 7.7G，而单场双份录制约 9G → **不足两场的余量**）。`1.17.4` 已引入"录像归档保留策略 + 重复文件延迟清理"，但当前 `.flv` 与 `.mp4` 并存暗示**清理策略未对这两场生效或尚未到期**。
- `docker system df` 显示 **3.694GB (99%) 可回收**，其中镜像层占绝大多数。清理 dangling 镜像可立即回收可观空间，是**性价比最高的缓解手段**。
- ⚠️ `Local Volumes` 有 **4 个卷且 ACTIVE=0**，但 `RUNTIME` 数据实际挂在 bind mount 上（`/opt/shn48/runtime/*`）。**这 4 个未被使用的卷需人工确认来源后再决定**——按纪律不得删除命名卷/运行数据。
- ⚠️ 发现两处**测试残留**在录像目录：`shn48-audit-test-50U0fv`、`shn48-audit-test-0vHHiI`（各 12K）——审计测试目录未清理，属低优先级卫生问题。

---

## 阻断级问题

**无。**

未发现任何构成"必须立即停止/回滚"的问题：
- 版本无漂移，本地与线上 7 处版本全部一致；
- 构建产物未被篡改（389 项哈希全量匹配，含容器内 135 项）；
- 生产健康、认证隔离正常、废弃高危接口已下线；
- 部署命令符合纪律（正确加载两个 Compose 文件）；
- 无"用历史包覆盖生产"的迹象（运行镜像标签与 revision 均为 1.17.5/20261011）。

---

## 高优先级问题

### H-1 🔴 明文 root 凭据 + 可利用 SSH 脚本落在同步盘，且未被任何 ignore 规则覆盖

- **位置**：`<root>\阿里云服务器.txt`（71 B）、`<root>\ssh_stage.py`、`<root>\ssh_stage_1171.py`、`<root>\ssh_stage_clean.py`
- **证据**：
  - `阿里云服务器.txt` 经正则验证**含 `密码：`/`密码:` 字段**（与脚本提取键一致）。
  - `ssh_stage.py`：
    ```python
    text=(root/'阿里云服务器.txt').read_text(...)
    password=re.search(r'密码[：:](.+)', text).group(1).strip()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('<SERVER_IP>',22,username='root',password=password,timeout=15)
    ```
    → 一条命令即可取得生产 root 权限；且 `AutoAddPolicy()` 不校验主机密钥（**易受中间人攻击**）。三个脚本均含 `rm -rf` 级别的远程部署命令。
  - `1.0.2/.gitignore` 未包含 `阿里云服务器.txt` 或 `ssh_stage*`（仅 `.env` 被忽略）。
  - 根目录本身**不是 git 仓库**（无 `.git`、无根级 `.gitignore`），因此**暂无"已提交推送"证据**；但目录位于 `D:\飞牛同步\...`（文件同步盘）。
- **违反条款**：`AGENTS.md`「**不得把密码、私钥、Cookie、`.env` 或其他凭据写入本文件、源码包或发布记录**」。
- **影响**：a) 明文生产 root 密码长期驻留；b) 若同步客户端已上传，凭据与可直接执行的入侵脚本将同时可达；c) 任一目录拷贝/打包/分享即等同交出服务器控制权。
- **缓解（未执行，供决策）**：① 将 `阿里云服务器.txt`、`ssh_stage*.py` 移出同步目录至本地非同步位置；② 立即**轮换**该 root 密码（视为已暴露更稳妥）；③ 改用 SSH 密钥 + 禁用 root 密码登录；④ 在 `.gitignore` 与 `.dockerignore` 中补充这两类模式，防止未来入库；⑤ 三个脚本改为从环境变量/密钥代理取凭据，去掉 `AutoAddPolicy`。
- **注意**：本次已确认这两个文件**未被打入任何发布的 tar 包**，故尚未形成"发布包携带凭据"的既成事实。

### H-2 🟠 9 个已发布版本完全缺失发布审计记录（1.16.0–1.16.4、1.17.0–1.17.2）

- **位置**：`1.0.2/docs/releases/`（应有 `1.16.0-audit.md` … `1.17.2-audit.md` 共 9 个文件）
- **证据**：已有审计版本集合（33 个）为 `…1.15.0, 1.15.1, 1.17.3, 1.17.4, 1.17.5`，**1.15.1 与 1.17.3 之间直接跳断**；CHANGELOG 有 46 个版本段落，其中 9 个无对应审计文件；根 `README.md` 第 15–22 行这 9 行的"记录"列皆为 `—`。
- **违反条款**：`release-process.md` 第 7 条要求"切换后核对…并**记录**镜像 ID 和验证结果"；`AGENTS.md` 要求"部署后核对线上健康接口、镜像版本及运行文件哈希"（隐含留痕）。
- **影响**：**这是本次最实质的流程缺陷**。1.16.x→1.17.2 恰是功能最密集的一段（在线 ASR 分片、AI 纠错、封面智能选帧、投稿质量闸门、自动回放补全…），如今**无发布记录可追溯**：无法回答"当时镜像 ID 是什么""回滚材料在哪""验证了哪些项"。这直接削弱事故回溯与回滚决策能力。
- **缓解**：为这 9 个版本补写审计记录（可据线上 `releases/`、历史镜像时间戳、CHANGELOG 反推）；若确实无据可查，应**像 1.0.0/1.0.1 那样显式声明"无法可靠追溯"**，而非留空 `—`。**前提：不得编造未发生的验证结果。**

---

## 中优先级问题

### M-1 🟡 生产根分区已用 80%，且单场录像双份留存，余量不足两场

- **证据**：`/dev/vda1 40G 30G 7.7G 80% /`；`runtime/recordings` = 19G；单场 `.flv`(2.9G)+`.mp4`(2.9G) 与另一场 1.6G+1.6G 并存。
- **影响**：按当前单场约 4.5–9G 的增量，**再录 1–2 场即可能触顶**，届时录制/归档/上传将失败。虽 `1.17.4` 已引入保留策略，但现状显示策略对近两场未及时生效（或因 24h 延迟清理窗口未到）。
- **缓解（未执行）**：确认 `1.17.4` 的延迟清理是否正常运行；对已完成归档且校验通过的场次，定向清理 `.flv` 原片；扩充磁盘或挂载数据盘。

### M-2 🟡 镜像与构建残渣堆积，3.694GB (99%) 可回收

- **证据**：`docker system df` → Images 62 个 / ACTIVE 2 / RECLAIMABLE **3.694GB (99%)**；`docker images -f dangling=true -q | wc -l` = **16**；历史镜像包含 `1.9.0`–`1.12.1`、`live-panel-20260913`、`danmaku-fix-20260913`、`rollback-before-1.0.2` 等 50+ 个标签。
- **违反风险**：`AGENTS.md` 明确「**不得直接使用无范围的 `docker system prune`**」「不得删除…仍需保留的回滚镜像」。
- **影响**：占满镜像层存储，且使"哪些是可回滚版本"难以辨认。
- **缓解（未执行）**：**人工核对后按 ID 定向删除** 16 个 dangling 镜像；对 1.13 及更早的非近期回滚标签，在确认 1.17.x 回滚路径充足后再逐批清理；保留 `shn48-recorder` 及其镜像、`rollback-1.17.2` 容器与 `1.17.x` 镜像、`1.16.4`（次新回滚点）。**清理结果须记录**（纪律要求）。

### M-3 🟡 公网明文 HTTP 暴露管理端，Cookie 以 `COOKIE_SECURE=false` 传输

- **证据**：`docker-compose.public.yml` 设置 `COOKIE_SECURE: "false"` + `TRUST_PROXY: "false"` + `ports: 0.0.0.0:3000:3000`；线上实测 `http://<SERVER_IP>:3000` 可直连，宿主机 `0.0.0.0:3000` 监听。文件内注释自述"Direct HTTP exposure is **for the temporary server test only**. Replace this override with a TLS reverse proxy before wider use."
- **影响**：管理端会话 Cookie 明文经公网传输，可被链路嗅探劫持；无 TLS 亦无法防篡改。**该风险已被项目自己识别但未闭环**（"临时"状态持续至 1.17.5 发布后 3 天仍未改变）。
- **缓解**：按 `docs/nginx.conf.example` 前置 TLS 反代，移除 public 覆盖档的明文端口，恢复 `COOKIE_SECURE=true` / `TRUST_PROXY=true`。

### M-4 🟡 本地缺失回滚材料的对应记录，无法离线复核

- **证据**：线上 `/opt/shn48/releases/1.17.5/pre-deploy/` 实存 3 个文件（`docker-compose.yml` 2511B、`docker-compose.public.yml` 313B、`VERSION` 7B）；本地**不存在** `releases/` 档案目录，仅有文档描述。
- **影响**：`1.17.5-audit.md` 第 42 行声称"发布前 Compose、`VERSION` 保存在 `<路径>`"——该声明**在本地方案中不可离线验证**，需连线上才能确认。属"记录指向不可本地复核"的闭合性缺口。
- **缓解**：在本地为每个版本保留 pre-deploy 快照的哈希清单（哪怕不存文件本体），或在审计记录中附上该目录的 SHA-256 清单，使本地可校验。

---

## 低优先级问题

### L-1 `CHANGELOG.md` 的 1.17.5 段落存在重复条目与断裂空行
- 第 9、10 行与第 12 行内容重复（第 12 行是前两行的合并版）；第 11 行为孤立空行导致 Markdown 列表断裂。已确认**非编码问题**（UTF-8 无 BOM）。
- 建议：删除第 12 行或删除第 9–10 行，保持单一口径。

### L-2 `CHANGELOG.md` 的 `Unreleased` 未清空，含占位句
- 第 3–5 行为 `## [Unreleased]` + `- 下一轮未发布变更待记录。`
- 建议：发布后 Unreleased 应为空标题，删除占位句，避免未来误以为有待发布内容。

### L-3 `1.0.2/.env.example` 存在中文乱码行
- 第 24 行：`# 鍚屼竴鎴愬憳銆佸悓涓€涓婚鍨嬫柇娴佸悗绛夊緟澶氫箙鍐嶅悎骞跺綊妗ｏ紙榛樿 5 鍒嗛挓锛?`（GBK 按 UTF-8 解码所致）
- 影响：该行是 `RECORDING_MERGE_WINDOW_MS` 的中文说明，**读者无法辨认**。其余文件（CHANGELOG、README、compose 注释）中文均正常。
- 建议：重新以 UTF-8 保存该行。另该行末尾疑似有 `?` 替换字符，需一并修正。

### L-4 根目录与 `release/` 目录中间产物无归档/清理计划
- 根目录 7 个 tar/包 + `backend-out.txt`；`1.0.2/release/` 下 107 个 `chunk_*.txt`（~1.28MB）+ 多个 `.b64`；`.tools/` 下大量 `.b64`。
- 其中 `deploy-js.gz`、`package-meta-1.17.0.tar.gz`、`backend-out.txt`、`chunk_*.txt` 属**明确中间产物**，无保留价值；`front-src-1.17.0.tar.gz`、`deploy-clean-*` 属**应保留的历史源码归档**。
- 建议：制定清单化归档计划（标明"保留/可删"及理由），并按 `AGENTS.md`「清理中间文件前确认范围」执行。

### L-5 `deploy-1.17.0.tar.gz` 内含 `server/node_modules/` 全量依赖
- 凭 6.33MB（远大于同代 clean 包的 1.05MB）且成员列表明确包含 `server/node_modules/...`。
- **违反** `AGENTS.md`「不将…`node_modules` 放入源码发布包」。
- 影响：作为"可保留归档"留存有误导风险（后人若误以此为部署基线会带入过期依赖树）。
- 建议：删除或明确标注为"含依赖的历史包，不可作为源码基线"。

### L-6 录像目录存在审计测试残留
- `runtime/recordings/shn48-audit-test-50U0fv`、`shn48-audit-test-0vHHiI`（各 12K）。建议清理测试目录。

### L-7 `docs/` 存在大量一次性部署文档，无索引
- `docs/` 顶层有 `deployment-*.md` 共 9 个（`deployment-20260904.md`、`deployment-covers-20260912.md`…）+ `docs/releases/` 33 个审计 + 4 个图片。
- 建议：补充索引或归入子目录，便于定位"当前有效文档"与"历史归档"。

---

## 仓库整洁与归档

### 根目录文件清单（合计 10.52 MB）
| 文件 | 大小 | 类别 | 建议 |
|---|---|---|---|
| `deploy-1.17.0.tar.gz` | 6,334,694 B | 历史部署包（**含 node_modules**） | ⚠️ 删除或明确标注 |
| `deploy-clean-1.17.2.tar.gz` | 2,052,762 B | 历史源码归档 | **保留** |
| `deploy-clean-1.17.1.tar.gz` | 1,056,951 B | 历史源码归档 | **保留** |
| `deploy-clean-1.17.0.tar.gz` | 1,052,423 B | 历史源码归档 | **保留** |
| `deploy-js.gz` | 361,479 B | 中间产物 | 可清理 |
| `front-src-1.17.0.tar.gz` | 125,097 B | 历史源码归档 | **保留**（AGENTS.md 明确要求） |
| `package-meta-1.17.0.tar.gz` | 28,530 B | 中间产物 | 可清理 |
| `README.md` / `AGENTS.md` | 10,598 / 2,447 B | 维护文档 | 保留 |
| `backend-out.txt` | 5,021 B | 运行日志残留 | 可清理 |
| `ssh_stage.py` / `_1171` / `_clean` | 900 / 854 / 841 B | 🔴 **含凭据读取逻辑** | **移出同步目录 + 改造** |
| `阿里云服务器.txt` | 71 B | 🔴 **明文凭据** | **移出 + 轮换密码** |

### 目录级杂乱
- `_debug/x164/` — 含**完整重复的** `.tools/cover-venv` 与 `1.0.2` 影子目录（`_debug\x164\1.0.2`、`_debug\x164\.tools\cover-venv\Lib\site-packages\{cv2,numpy,PIL,pip}`）→ 明显是一次调试目录的无意嵌套，**占空间且易混淆**，建议确认后删除。
- `1.0.2/release/` — 107 个 `chunk_*.txt` + `*.b64` + 4 个 `dist-before-1.14.x/` → **`dist-before-*` 是宝贵的"发布前 dist 快照"（回滚可比对），建议保留**；`chunk_*.txt` 是分片传输残留，可清理。
- `.tools/` — 大量 `.b64`/`.tar.gz`/`.txt` 混杂（`1.1.0-files.txt`…`1.8.0-files.txt` 属历史文件清单，有溯源价值）。
- `archives/`、`research/`、`uploadchunks/` — 本次未深入（非版本发布路径）。

### 归档纪律遵守情况小结
| 纪律 | 状态 |
|---|---|
| 保留历史源码归档 | ✅ 已保留（`deploy-clean-*`、`front-src-*`、`release/shn48-1.1x-source.tar.gz`） |
| 清理中间文件前确认范围 | ⚠️ 未见任何范围确认文档或归档计划 |
| 不把 node_modules 放入源码包 | ❌ `deploy-1.17.0.tar.gz` 违反 |
| 不把凭据写入发布记录/源码包 | ✅ 发布包内无 `.env`/`cookies`/`config.yaml`；❌ 但根目录有明文凭据文件（H-1） |
| 保留当前运行容器、不用无范围 prune | ✅ 线上仅有 1 个回滚容器，无 prune 痕迹 |
| 生产 `.env` 权限 | ✅ 600（含 3 个备份） |

---

## 未验证的部分

| 项 | 原因 | 说明 |
|---|---|---|
| `node scripts/version.mjs check` **实跑** | **本机无 `node`/`npm`**（`node`、`npm` 均不在 PATH，`Get-Command` 返回空） | 改为**静态审读脚本源码 + 手工逐项比对 7 处版本位置**，结论（全部一致）可靠；但"脚本能否无错退出"未经运行时验证。`1.17.5-audit.md` 记录当时已通过。 |
| 前端构建（`npm run build`） | 同上（无 node/npm） | 未重跑；改为**用哈希清单反向验证既有 dist 产物完整性**（254+135 全匹配），可证明产物未被改动，但**不能证明源码可重新构建出相同产物**。 |
| 服务端 / 前端测试套件 | 同上（无 node/npm） | 未执行。`1.17.5-audit.md` 自己记录了当时的失败项（音频分片续传测试失败、浏览器布局测试因无 Chromium 未完成）——**该记录诚实，但意味着 1.17.5 发布时测试并非全绿**，属遗留风险，非本次新增。 |
| `docs/releases/*.json`（`1.0.2-cleanup.json` 等）内部字段逐项核对 | 未展开（4 个 JSON 文件，本次聚焦 audit.md 覆盖） | 建议后续补充。 |
| `archives/`、`research/`、`uploadchunks/` 目录内容 | 未展开（非版本发布/线上运维路径，且任务未要求） | 若需审计历史归档完整性，应另开一轮。 |
| 生产磁盘**历史增长趋势**（是否在加速逼近） | 只读快照无法得出趋势 | 建议部署磁盘监控或定期记录 `df` 采样。 |
| 4 个 `Local Volumes` 的来源与用途 | 只读未深查（`docker volume ls` 未列入本次命令集） | **按纪律不得贸然删除**；建议人工核对后再决策。 |
| 同步盘（飞牛同步）**是否已把凭据文件上传到远端** | 超出本次权限与工具范围 | H-1 的风险评级已按"可能已同步"从保守角度给出。 |
| 生产 `config/config.yaml` 内容（是否含密钥） | **刻意未读取**（可能含 API 密钥，属凭据范畴） | 仅记录其存在与宿主路径 `/opt/shn48/config`；权限与内容未核。 |
| `阿里云服务器.txt` 具体内容 | **按任务要求不复述** | 仅以正则模式验证其**含 `密码：` 字段**这一事实。 |

---

## 附：本次执行的全部只读命令（可复核）

```
# dstatus
list_servers                                          # 现场确认阿里云 ID
docker ps -a --filter name=shn48 --format ...         # 容器状态
docker inspect shn48-recorder --format '{{json .Config.Labels}}'
docker inspect shn48-recorder --format '{{.Image}}; {{.State.Health.Status}} {{.State.StartedAt}}'
docker inspect shn48-recorder --format '{{range .Mounts}}...'   # 挂载
docker exec shn48-recorder cat /app/VERSION
docker exec shn48-recorder pwd / ls /  / ls /app
docker exec shn48-recorder sha256sum /entrypoint.sh
docker exec -i shn48-recorder bash -c '<对 /app 逐条校验>' < /opt/shn48/releases/1.17.5/RUNTIME-SHA256SUMS
curl -s http://127.0.0.1:3000/api/public/health
curl -s -o /dev/null -w '%{http_code}' .../api/admin/pocket48/recordings/active   # 401
curl -s -o /dev/null -w '%{http_code}' '.../api/stream/proxy?url=...'            # 404
df -h / ; du -sh /opt/shn48/runtime/*
docker images shn48-shn48 --format ... ; docker images -f dangling=true -q | wc -l
docker system df
ls -la /opt/shn48/ ; ls -la /opt/shn48/releases/ ; ls -laR /opt/shn48/releases/1.17.5/pre-deploy/
ls -la /opt/shn48/deploy/
(ss -tlnp | grep -E ':3000|:22')
```
**全部为读取类操作。未执行任何 `docker run/stop/rm/rmi/prune`、未修改任何文件、未部署任何内容。**

---

*报告生成：2026-10-14 | 审查员：发布工程与线上运维审查（只读）*
