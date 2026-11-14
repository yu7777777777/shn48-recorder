# 发布与版本规范

当前正式版本以 `app/VERSION` 为准（2026-10-15 核对时为 **1.17.8**）。`app/` 是维护目录名，**不是版本号**；目录名固定不变，版本只看 `VERSION`。生产路径 `/opt/shn48`，服务 `shn48-recorder`，入口 `http://<SERVER_IP>:3000`。

> 完整部署步骤（含换新服务器）见 [deployment-guide.md](deployment-guide.md)。本文只规定版本与发布流程。

1. 开发期间将变更写入 CHANGELOG.md 的 Unreleased；不为每次编辑升级版本。
2. 发布修复用 PATCH，新增兼容功能用 MINOR，不兼容变更用 MAJOR。执行 `node scripts/version.mjs set X.Y.Z`，再将 Unreleased 整理为带日期的版本条目。该脚本只改项目自身版本，不改第三方依赖版本。
   - **`version.mjs` 目前只改 `VERSION`，不同步 `server/package.json` 的 `version`/`description`。** 2026-10-15 核对发现线上镜像内 `server/package.json` 仍写着 `1.17.4`、`client/dist/index.html` 标题仍是 `1.17.4`，而 `/app/VERSION` 已是 `1.17.8`——两者长期漂移。升版时需一并更新 `server/package.json` 与 `client/package.json` 的版本字段，避免元数据与运行版本不符。
3. 执行 `node scripts/version.mjs check`、`npm --prefix server test`、`npm --prefix client test` 和 `npm --prefix client run build`，记录通过/失败/跳过及原因。
4. 执行 `node scripts/manifest.mjs` 生成源码和 dist 的 SHA-256 清单及发布包；排除 node_modules、.env、运行账号配置、录像。清单排除 docs/releases 审计记录以允许写入部署结果。保留部署前镜像、Compose 和代码备份。
5. `Dockerfile` 是完整构建入口。`Dockerfile.release` 仅用于复用已验证的生产依赖；依赖变化时必须全量构建。使用 release 构建时准备专用 context，包含 server、client/dist、entrypoint.sh、VERSION 和 Dockerfile.release，不包含 node_modules，也不能用忽略 dist 的根 .dockerignore。
6. 先用真实 ENTRYPOINT 启动不挂载生产数据的候选容器，验证脚本执行权限、健康接口、认证保护、页面和版本；确认无录制/归档/上传任务后切换镜像。禁止同时启动两套共享生产数据的主服务。
7. 切换后核对公开健康接口版本、Docker 标签、全部后端与生效前端资源哈希，并记录镜像 ID 和验证结果。失败时先停止新容器，再恢复原 Compose 镜像；不覆盖运行数据。
8. 完成验证后清理临时包和构建缓存，保留一个版本发布包、核对报告、更新记录及必要回滚材料。
