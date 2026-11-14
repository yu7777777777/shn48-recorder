# 工作区文件说明

本文件说明 `shn48录制/` 工作区的目录用途、归档规则与常用命令。整理日期：2026-10-15。

## 目录总览

| 目录 | 用途 | 是否进发布包 | 是否进 Git |
| --- | --- | --- | --- |
| **`app/`** | **当前唯一维护目录**。所有开发、构建、发布都在这里 | 是（其内容即发布包） | 是 |
| `archives/` | 历史源码、发布包、整理前基线、本地调试产物 | 否 | 否（已忽略） |
| `release/` | 近期（1.17.6–1.17.7）发布中间产物，仍在参考期内 | 否 | 否（已忽略） |
| `research/` | 上游参考项目（`48tools`、`pocket48-cli`），仅维护参考 | 否 | 否 |
| `.tools/` | 本地工具：ffmpeg、离线 ASR 模型、封面测试夹具、Python venv | 否 | 否（已忽略） |
| `staging/` | 临时日志与中间文件，可随时清理 | 否 | 否 |
| `AGENTS.md` | 项目约定（维护目录、发布规范、凭据纪律） | — | 是 |
| `README.md` | 版本一览与项目索引 | — | 是 |

### 关于 `app/` 这个目录名

`app/` 是**当前唯一维护目录**，目录名**不含版本含义**。版本号只看 `app/VERSION`（当前 `1.17.8`）。设计上目录名固定不变，**后续版本不再复制整套目录**——直接在 `app/` 内开发，用 `node app/scripts/version.mjs set X.Y.Z` 升版。

> **改名说明（2026-10-15）**：该目录原名为 `1.0.2/`，是 2026-09-16 建立基线时留下的版本号式命名。它长期与「版本只看 `VERSION`」的规则矛盾，容易被误读成"当前版本是 1.0.2"——尤其在线上宿主机源码树（`/opt/shn48/VERSION` 为 1.17.5）与镜像版本（1.17.8）本就不一致的情况下更易误导。现改为语义化名称 `app/`，版本只由 `VERSION` 表达。已确认 `Dockerfile`、`docker-compose*.yml`、`version.mjs`、`manifest.mjs` 均不依赖目录名。

---

## 分级保留规则

整理时按「是否还有排障/回滚价值」分三层，而非一律删除：

| 层 | 位置 | 内容 | 处置 |
| --- | --- | --- | --- |
| **1 现行** | `app/`、`release/` | 当前版本源码与近期产物 | 保留，正常使用 |
| **2 归档** | `archives/release-packages/` | 1.9.0 – 1.16.4 的历史发布包 | 保留，按需取用 |
| **2 归档** | `archives/root-level-packages/` | 原散落在工作区根目录的部署包（1.17.0–1.17.2） | 保留，已归类 |
| **3 隔离** | `archives/local-debug-quarantine/` | `_debug/`、`undefined/`、`uploadchunks/`、`%SystemDrive%/` | 保留但隔离，确认无用后可删 |

**没有删除任何文件**，只做了移动与归类。第三层内容确认为本地调试残留，若确认无价值可整体删除以回收约 44 MB。

---

## 本次整理做了什么

1. **维护目录更名 `1.0.2/` → `app/`**：消除目录名与版本号长期矛盾。已同步更新 `AGENTS.md`、根 `README.md`、本项目内文档及 `scripts/write-deploy-notes.sh` 的路径引用；历史核对文档与 `package-lock.json` 中的 `1.0.2` 字样刻意保留（分别为历史事实与第三方依赖版本）。
2. **根目录从 20 项收敛到 4 项**：散落包与日志移入 `archives/` 与 `staging/`。
3. **`archives/` 内部再分类**：新增 `release-packages/`、`root-level-packages/`、`local-debug-quarantine/` 三个子目录。
4. **`release/` 只留近期产物**（1.17.6–1.17.7），旧包移入 `archives/release-packages/`。
5. **`deploy.py` 移入 `app/scripts/`**：它是当前有效的部署工具（凭据从环境变量读取），原先散在根目录。
6. **清理**：空目录 `docs/`（误建残留）、`server/modules/*/__pycache__/`（2026-09 的字节码缓存，含旧路径字符串，`.dockerignore` 本就排除）、2 个部署日志（移入 `staging/logs/` 保留）。

### 需要注意的既有问题

- **`archives/release-packages/shn48-1.16.4-source.tar.gz` 是错误产物**（303 MB）：名为「source」但实际打包了**整个工作区**，含 `research/` 与 `.git/`，共 4373 项，远超同类包的 1–3 MB。其它历史包都是干净的源码包。此包不应作为发布参考，保留仅为避免丢失历史。
- **本地 `app/client/dist/` 是 1.17.7 产物**，落后于线上运行的 1.17.8。如需对齐须重新构建（本次未做）。

---

## 常用命令

均在本目录（`shn48录制/`）下执行。

```bash
# 查看当前正式版本
cat app/VERSION

# 升版（改 VERSION 并整理 CHANGELOG）
node app/scripts/version.mjs set 1.17.9
node app/scripts/version.mjs check

# 运行测试与构建
npm --prefix app/server test
npm --prefix app/client test
npm --prefix app/client run build

# 生成校验清单
node app/scripts/manifest.mjs

# 本地联调
cd app && docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

> ⚠️ 本机当前 **`node` 不在 PATH**，上述命令需先配置 Node 20 环境。

### 部署到服务器

凭据**只从环境变量读取**，不要写进文件：

```bash
export SHN48_HOST=<服务器IP>
export SHN48_USER=root
export SHN48_PASSWORD=<密码>        # 或用 SHN48_KEYFILE 走密钥
python app/scripts/deploy.py <本地包> <远程相对目录> [--extract]
```

完整部署步骤见 [app/docs/deployment-guide.md](app/docs/deployment-guide.md)。

---

## 凭据纪律

工作区根目录存在 `阿里云服务器.txt`，以**明文**保存生产 root 密码。

- 该文件已在 `.gitignore` 中，**不会**进入 Git 或发布包；
- 但工作区位于**同步盘**，密码可能已扩散到其他设备或云端；
- 发布包生成脚本必须排除它。

**建议整改**：删除该文件 → 改用 SSH 密钥或 `SHN48_*` 环境变量 → 轮换一次服务器 root 密码。详见[安全收尾](app/docs/deployment-guide.md#10-安全收尾)。

---

## 相关文档

| 文档 | 用途 |
| --- | --- |
| [README.md](README.md) | 版本一览与项目索引 |
| [AGENTS.md](AGENTS.md) | 项目约定 |
| [app/docs/deployment-guide.md](app/docs/deployment-guide.md) | **换服务器部署手册** |
| [app/docs/release-process.md](app/docs/release-process.md) | 发布与版本规范 |
| [app/docs/releases/1.17.8-audit.md](app/docs/releases/1.17.8-audit.md) | 1.17.8 线上核对 |
| [app/CHANGELOG.md](app/CHANGELOG.md) | 完整更新记录 |
