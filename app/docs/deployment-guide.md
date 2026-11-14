# 换服务器部署手册

面向「在一台全新服务器上把本项目跑起来」的完整步骤。适用于迁移、重建灾备、或本地复现生产环境。

- 编写日期：2026-10-15
- 编写时正式版本：**1.17.8**（以 `app/VERSION` 为准）
- 现网参考：阿里云 `<SERVER_IP>`，`/opt/shn48`，容器 `shn48-recorder`
- 前置阅读：[发布与版本规范](release-process.md)；安全边界见 [app/README.md](../README.md)

> 本文所有命令均在**目标服务器**上执行，除非标注「本地」。**不要**把密码、`.env`、`cookies.json`、私钥写进源码包、Git 或本文档。

---

## 0. 迁移前必读

### 三个必须理解的现实约束

1. **线上宿主机源码树不代表运行内容。** 2026-10-15 核对时，`/opt/shn48/VERSION` 是 `1.17.5`，宿主机 `server/package.json` 是 `1.17.4`，而运行镜像 `/app/VERSION` 是 `1.17.8`。历次发布只构建镜像、没同步宿主机源码树。**回滚与核对请以镜像为准，不要以宿主机源码树为准。**
2. **本项目只支持 Docker Compose 部署。** 发布包不含直跑 Node 的部署脚本。
3. **口袋48 接口需要中国大陆网络出口。** 境外服务器可能无法访问或触发风控。

### 迁移清单（决定成败的是下面这四项）

| 数据 | 路径 | 现网大小 | 丢失后果 |
| --- | --- | --- | --- |
| 运行状态 | `runtime/data/` | 236 MB | 管理员凭据、自动录制/签到配置、ASR 模型、分析结果全丢 |
| 录像归档 | `runtime/recordings/` | 888 MB | 本地录像丢失（不可再生） |
| B站凭据 | `runtime/biliup/cookies.json` | 1.5 KB | 需重新扫码登录 |
| 运行配置 | `config/config.yaml` | 495 B | 需重新在页面配置 |

> `runtime/data/asr-models/` 是离线转写模型，体积大但可重新下载。若磁盘紧张可不迁移，之后在设置页重新下载。

---

## 1. 目标服务器要求

| 项 | 要求 |
| --- | --- |
| 系统 | Linux（x86_64）；现网为 Debian，内核 `5.10.0-15-amd64` |
| Docker | Docker Engine 20.10+；**Compose v1（`docker-compose`）或 v2（`docker compose`）均可** |
| 磁盘 | **建议 ≥ 40 GB**；现网 40 G 已用 22 G。录像持续增长，需按录制量预留 |
| 内存 | 现网 4 GB 可运行；录制并发与 `ASR_CONCURRENCY` 会吃内存 |
| 网络 | **必须能稳定访问口袋48**（中国大陆出口），且能拉取 Docker Hub / apt / npm |
| 端口 | 3000（若直接暴露）或由反向代理转发 |

安装 Docker（Debian/Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker-compose --version   # 或 docker compose version
```

---

## 2. 准备部署目录

```bash
mkdir -p /opt/shn48
cd /opt/shn48
```

把发布包解压到 `/opt/shn48`，得到 `server/`、`client/`、`config/`、`Dockerfile`、`docker-compose*.yml`、`entrypoint.sh`、`VERSION` 等。

> 若从现有机器同步源码，注意排除 `node_modules/`、`.env`、`runtime/`、`.git/`。

---

## 3. 创建 `.env`（最容易出错的一步）

```bash
cp .env.example .env
chmod 600 .env
```

### 3.1 三个必填项

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<独立强密码，不要复用任何已有密码>
SESSION_SECRET=<至少 32 字节随机值>
```

生成 `SESSION_SECRET`：

```bash
openssl rand -base64 48
```

> **这两个值只是首次启动的初始凭据。** 首次在页面改密后，凭据会原子写入 `runtime/data/admin-credentials.json`（权限 `0600`），此文件优先于环境变量。改密后**不要**再依赖 `.env` 里的旧值。

### 3.2 现网实际使用的关键项

现网 `.env` 与 `.env.example` 存在差异，迁移时请照抄现网取值：

```dotenv
HOST_PORT=3000
CONFIG_DIR=./config
DATA_DIR_HOST=./runtime/data
RECORDINGS_DIR_HOST=./runtime/recordings
BILIUP_DIR=./runtime/biliup
COMPOSE_NETWORK_NAME=shn48-web
ENABLE_XVFB=0
COOKIE_SECURE=true
TRUST_PROXY=true
DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
NPM_REGISTRY=https://registry.npmmirror.com
HF_ENDPOINT=https://huggingface.co
ASR_CHUNK_SECONDS=600
ASR_CONCURRENCY=20
```

**注意**：`ASR_CHUNK_SECONDS=600` / `ASR_CONCURRENCY=20` 是现网实测可用的网关配置，与 `docker-compose.yml` 内的默认值一致。降低并发可缓解小内存或上游限流。

### 3.3 关键开关说明

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COOKIE_SECURE` | `true` | 用 HTTPS 时保持 `true`；**纯 HTTP 访问必须设 `false`，否则无法登录** |
| `TRUST_PROXY` | `true` | 有反向代理时 `true`；直接暴露 3000 时设 `false` |
| `ENABLE_XVFB` | `0` | DDTalks 不属于 MVP，非必要不要开 |

---

## 4. 建立持久化目录

```bash
mkdir -p runtime/data runtime/recordings runtime/biliup config
chmod 700 runtime/data runtime/biliup
```

`config/config.yaml` **不需要预先创建**：容器启动时 `entrypoint.sh` 会自动从 `/app/config-defaults/config.example.yaml` 复制一份（见 `entrypoint.sh` 第 9–12 行）。

---

## 5. 构建并启动

### 5.1 场景 A：全新部署（无历史数据）

```bash
cd /opt/shn48
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

> 使用 `docker-compose.public.yml` 会**把 3000 端口直接暴露到公网并关闭安全 Cookie**。仅适用于无反向代理的临时验收，见下方「安全部署方式」。

### 5.2 场景 B：迁移现网（带历史数据）

**先停止旧服务器上的容器**，避免两边同时写入同一批数据：

```bash
# 在旧服务器执行
cd /opt/shn48 && docker-compose down
```

然后同步数据（在**新服务器**执行，从旧服务器拉取）：

```bash
cd /opt/shn48
# 方式一：rsync（推荐，可续传）
rsync -avz --progress root@<旧服务器IP>:/opt/shn48/runtime/data/       runtime/data/
rsync -avz --progress root@<旧服务器IP>:/opt/shn48/runtime/recordings/ runtime/recordings/
rsync -avz --progress root@<旧服务器IP>:/opt/shn48/runtime/biliup/     runtime/biliup/
rsync -avz --progress root@<旧服务器IP>:/opt/shn48/config/config.yaml  config/config.yaml
```

或打包传输：

```bash
# 旧服务器
cd /opt/shn48 && tar -czf /tmp/shn48-data.tar.gz runtime/data runtime/recordings runtime/biliup config/config.yaml
# 新服务器
cd /opt/shn48 && tar -xzf /tmp/shn48-data.tar.gz
```

传输后校正权限：

```bash
chmod 700 runtime/data runtime/biliup
chmod 600 config/config.yaml runtime/data/admin-credentials.json runtime/biliup/cookies.json 2>/dev/null
```

再启动：

```bash
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

### 5.3 安全部署方式（有反向代理，推荐）

只加载基础 compose，不加载 `.public` 覆盖。此时容器只有 `expose: 3000`，端口**不发布到宿主机**：

```bash
docker-compose up -d --build
```

让 Nginx/Caddy/Traefik 容器加入 `shn48-web` 网络并代理到 `shn48:3000`。示例见 [nginx.conf.example](nginx.conf.example)（**必须替换域名与证书路径**）。

**切勿**把端口绑定为 `0.0.0.0:3000` 长期对外。

---

## 6. 验证部署

### 6.1 容器与健康检查

```bash
docker ps --filter name=shn48-recorder
docker logs --tail 50 shn48-recorder
curl -s http://127.0.0.1:3000/api/public/health
```

期望返回：

```json
{"success":true,"data":{"status":"ok","version":"1.17.8"}}
```

镜像自带 healthcheck（`Dockerfile` 第 65–66 行），30 秒一次。`Up (healthy)` 即通过。

### 6.2 版本一致性

```bash
cat VERSION                                    # 宿主机
docker exec shn48-recorder cat /app/VERSION    # 容器内
curl -s http://127.0.0.1:3000/api/public/health | grep -o '"version":"[^"]*"'
```

三处应一致。**若不一致，说明镜像与源码不匹配**（这正是 2026-10-15 核对时发现的问题）。

### 6.3 冒烟测试

```bash
cd /opt/shn48
export SMOKE_BASE_URL=http://127.0.0.1:3000
export SMOKE_ADMIN_USERNAME=admin
export SMOKE_ADMIN_PASSWORD=<.env 中的 ADMIN_PASSWORD>
node scripts/smoke-test.mjs
```

> 需要宿主机有 Node 20。若没有，可在容器内执行：`docker exec -it shn48-recorder node /app/scripts/smoke-test.mjs`（前提是该脚本已打进镜像）。

脚本验证：健康接口匿名可访问、未登录访问管理接口返回 401、旧的任意 URL 代理返回 404/410、管理员登录成功、退出成功。

### 6.4 人工验收清单

- [ ] `curl http://127.0.0.1:3000/api/public/health` 返回 `version` 与 `VERSION` 文件一致
- [ ] 浏览器打开公开页，能显示直播列表（或「现在没有正在进行的直播」）
- [ ] 公开页**不**显示任何管理入口
- [ ] `/admin` 可登录；未登录直接访问 `/admin` 会被挡回登录页
- [ ] 未登录时 `curl -i http://127.0.0.1:3000/api/admin/pocket48/auto-recording` 返回 **401**
- [ ] 迁移场景：录像归档页能看到历史录像；自动录制/签到配置仍在
- [ ] 迁移场景：B站账号页显示已登录（说明 `cookies.json` 迁移成功）
- [ ] 若启用离线转写：设置页能看到 ASR 模型

---

## 7. 反向代理与 HTTPS

生产**必须**用 HTTPS 反向代理，不能直接暴露 Node 的 3000。

Nginx 要点：

```nginx
location / {
    proxy_pass http://shn48:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;   # 长请求：ASR、录制、下载
    proxy_buffering off;       # 流代理与 SSE 需要
}
```

- 使用 HTTPS 时保持 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。
- 建议公开站与管理站分域名，公开站在代理层拒绝 `/admin` 与 `/api/admin/*`。
- 详见 [app/README.md](../README.md) 的「安全边界」章节。

---

## 8. 回滚

**回滚路径是「镜像 + compose 备份」，不是改名保留旧容器。**

原因：现网 Docker Compose 为 **v1（1.25.0）**，`up -d` 会按 `container_name: shn48-recorder` 重建容器，改名保存的旧容器会被一并删除，**不能**作为回滚依据。

```bash
cd /opt/shn48
# 1) 备份当前 compose
cp docker-compose.yml docker-compose.yml.pre-<新版号>
# 2) 把 image: 改回上一个可用标签，例如 shn48-shn48:1.17.7
# 3) 重新起容器
docker-compose up -d
```

可用回滚镜像（2026-10-15 核对时线上留存）：

| 标签 | 镜像 ID |
| --- | --- |
| `shn48-shn48:1.17.8` | `23f0e7ddfe40`（当前运行） |
| `shn48-shn48:1.17.7` | `c5c2dcd12a19` |
| `shn48-shn48:1.17.2` | `d1602ed1db83` |

**回滚前先停服务**（`docker-compose down`），且**不要用旧数据快照覆盖新数据**——迁移期间产生的新录像与新上传记录会丢失。

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 无法登录，反复跳登录页 | 纯 HTTP 访问但 `COOKIE_SECURE=true`。设 `COOKIE_SECURE=false` 或改用 HTTPS |
| 容器启动即退出 | `docker logs shn48-recorder`。常见：`.env` 缺 `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`SESSION_SECRET`（compose 用 `:?` 强制校验） |
| 公开页看不到直播 | 检查服务器能否访问口袋48；境外出口常失败 |
| `docker build` 报 `max depth exceeded` | overlayfs 层数超限。见下方「已知坑」 |
| 迁移后需重新登录旧会话 | 预期行为。`SESSION_SECRET` 变化会使全部会话失效 |
| 磁盘迅速被占满 | 录像持续增长。设置保留策略，或扩容 |

### 已知坑：overlayfs 层数超限

现网内核 `5.10.0-15-amd64` 的 overlayfs 层数上限已被历次 `COPY` 式发布累积到 **169 层**。任何在旧镜像之上再改文件系统的 `docker build` 都会报 `max depth exceeded`（`LABEL`/`COPY`/`RUN` 均失败，仅 `FROM` 可通过）。

**处理方式**：

- 用完整 `Dockerfile` 做一次**全量重建**以归零层数（推荐，但耗时长且需能拉取依赖）；
- 或用 `docker export` 把旧镜像压平成单层基线再在其上构建（1.17.8 的临时做法，产物 `shn48-shn48:squash-1177`）。

---

## 10. 安全收尾

- [ ] `.env` 权限 `600`，不在 Git 中
- [ ] 首次登录后**立即改密**（`/admin/security`），旧会话会全部失效
- [ ] 3000 端口未直接暴露公网
- [ ] 公开域名无法访问 `/admin` 与 `/api/admin/*`
- [ ] `runtime/data/admin-credentials.json`、`runtime/biliup/cookies.json` 权限 `600`
- [ ] **删除任何明文保存服务器密码的文件**（见下）
- [ ] 建立录像保留策略与磁盘告警

> ⚠️ 本工作区曾存在 `阿里云服务器.txt`，以明文保存生产 root 密码。该文件在 `.gitignore` 中，但所在目录为同步盘，密码可能已扩散到其他设备或云端。**建议：删除该文件 → 改用 SSH 密钥 → 轮换一次服务器 root 密码。**

---

## 11. 相关文档

| 文档 | 用途 |
| --- | --- |
| [release-process.md](release-process.md) | 版本号规则与发布流程 |
| [1.17.8-audit.md](releases/1.17.8-audit.md) | 1.17.8 线上状态与哈希核对 |
| [1.17.8-release-notes.md](releases/1.17.8-release-notes.md) | 1.17.8 改了什么 |
| [nginx.conf.example](nginx.conf.example) | 反向代理示例 |
| [offline-asr.md](offline-asr.md) | 离线转写配置 |
| [app/README.md](../README.md) | 功能说明与安全边界 |
| `../CHANGELOG.md` | 完整更新记录 |
