# 已归档：美国服务器时期部署记录（2026-09-04 ~ 2026-09-13）

## 为什么归档

这些文档记录的是**已退役的美国服务器**（`<US_SERVER_IP>`，`/opt/shn48`）上的部署操作，镜像标签形如 `shn48-shn48:archive-20260904`、`checkin-20260913`。

根据 [migration-aliyun-20260913.md](../../migration-aliyun-20260913.md) 记载，服务已于 2026-09-13 迁移至阿里云 `<SERVER_IP>`，此后美国端的**旧容器、专用镜像标签、`shn48-web` 网络、`/opt/shn48`、迁移包与备份均已删除**，临时入口转发与隧道已停用、专用密钥与脚本已删除。

因此这些文档中：

- **镜像标签与镜像 ID 全部失效**，无法再 `docker images` 找到，也**不能**用于回滚；
- **服务器路径与公网地址已不存在**；
- 其中的部署脚本为当次迁移专用，**不能直接重复运行**。

它们保留的价值仅是**历史排障参考**：记录当时某个功能是如何上线与验证的。**不要**照此文档在现网执行任何命令。

## 当前有效的文档

| 需求 | 当前文档 |
| --- | --- |
| 在新服务器部署 | [../../deployment-guide.md](../../deployment-guide.md) |
| 发布与版本规范 | [../../release-process.md](../../release-process.md) |
| 迁移历史（阿里云） | [../../migration-aliyun-20260913.md](../../migration-aliyun-20260913.md) |
| 各版本发布核对 | [../../releases/](../../releases/) |

## 归档文件清单

| 文件 | 主题 | 原镜像标签 |
| --- | --- | --- |
| `deployment-20260904.md` | 录像归档更新 | `archive-20260904` |
| `deployment-covers-20260912.md` | 封面功能 | — |
| `deployment-login-20260912.md` | 登录方式更新 | — |
| `deployment-pocket48-20260912.md` | 口袋48 工作台 | — |
| `deployment-queryfix-20260912.md` | 签到与房间查询修复 | — |
| `deployment-bubbles-20260913.md` | 三列气泡消息 | — |
| `deployment-chatrooms-20260913.md` | 成员与粉丝消息接入 | — |
| `deployment-merged-20260913.md` | 两列合并与翻牌 | — |
| `deployment-roomfix-20260913.md` | 房间名称与消息兼容修复 | — |
| `deployment-checkin-20260913.md` | 紧凑账号栏与自动签到 | `checkin-20260913` |

> 各版本的功能说明已完整并入 [../../../CHANGELOG.md](../../../CHANGELOG.md) 与 [../../releases/](../../releases/) 中的发布核对记录，归档文件不含独有的有效信息。
