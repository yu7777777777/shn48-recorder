# 48tools 录制服务

私有部署的口袋48 直播录播中枢：从直播发现、自动录制、归档管理，到 B 站投稿与 115 备份的完整工作台。公开页面展示直播与官方回放；录制、归档、投稿等管理能力全部在管理员登录之后。

> 本项目为个人自用的粉丝工具，与 SNH48 GROUP / 丝芭传媒 / 口袋48 官方无关。

**2026-11-14 线上发布 2.0.0：功能精简，回归录制核心链路**。移除 AI/分析线（ASR 字幕、AI 总结、弹幕高能、字幕搜索、AI 封面、高光切片、投稿文案、公开日报/RSS）、通知推送系统、剪辑工作台与转码导出、DDTalks 与房间语音；归档操作并入归档列表页，Dockerfile 大幅瘦身（不再拉取 PyPI 大包）。删除属于不可逆 MAJOR 变更，存储与备份格式不变。已按标准流程部署：155 项运行文件哈希一致，healthy。详见 [2.0.0 发布核验](app/docs/releases/2.0.0-audit.md)。

## 主链路

```text
口袋48直播发现 → 网页实时播放 → 自动录制 → 归档合并 → B站草稿
```

## 功能总览

**录制与归档**

- 自动录制：选择成员启用，按场轮询并发录制（1–20 场），断流 5 分钟内自动合并为同一场，杜绝重复归档
- 归档主文件 MP4 完成时长核验与完整解码检查；原始 FLV 保留以便恢复
- 智能封面：按成员照片与时间线自动选帧渲染，可批量生成与手动替换
- 磁盘水位清理：低于保留线自动回收原始片段与缓存，**归档主文件永不自动删除**
- 官方回放修复：重连直播时间轴无损拼接、逐段解码核验，"已修复 · 官方源受限"明确标注未补回内容
- 官方回放完整下载：页面受控下载与校验，可转投 B 站

**发布与备份**

- B 站草稿队列：单并发上传、断点续传；归档列表内一键送入队列
- 115 网盘备份：离线异步上传、SHA-256 校验，本地原件永不删除

**公开页面**（无需登录）

- 当前直播、口袋48 官方成员回放（含受控完整下载）
- 成员社交账号聚合页（访问码控制）

**运维与自动化**

- 自动签到、成员真实关注 / 取关、房间消息阅读
- **版本自动更新**：定时比对 GitHub 仓库发布版本与运行版本，新版本在「版本更新」页提示，人工确认后在服务器一条命令完成「拉取 → 源码核验 → 构建 → 切换 → 健康与运行文件哈希核验 → 失败自动回滚」（公开仓库全程零凭据）

## 快速开始

```bash
cp app/.env.example app/.env        # 填入 ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET
cd app
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d
curl http://127.0.0.1:3000/api/public/health
```

完整步骤（配置口袋48账号、B站扫码登录、115 授权、自动录制）见[部署指南](app/docs/deployment-guide.md)。

## 安全边界

单一 Node 服务，接口严格分层：`/api/public/*` 只读且无登录态；`/api/admin/*` 全部由后端验证管理员会话；改密接口额外验证当前密码。会话凭据、B站 Cookie、115 授权均只存服务器数据目录。

## 文档

| 文档 | 内容 |
|---|---|
| [app/README.md](app/README.md) | 系统详解：主链路细节、安全边界、各版本能力说明 |
| [部署指南](app/docs/deployment-guide.md) | 从零部署、账号配置、数据迁移 |
| [115 备份设计](app/docs/115-backup-design.md) | 备份 worker、校验与恢复 |
| [发布流程](app/docs/release-process.md) | 版本号、测试、清单、部署核验约定 |
| [更新记录](app/CHANGELOG.md) | 全部版本变更 |
| [公开前检查清单](PUBLIC-CHECKLIST.md) | 仓库公开化的内容约束 |

## 更新记录

当前正式版本：**2.0.0**（以 [app/VERSION](app/VERSION) 为准）。`Unreleased` 段记录未发布内容；历次发布的详细变更见 [app/CHANGELOG.md](app/CHANGELOG.md)， narrative 式发布公告存档见 [docs/release-announcements.md](docs/release-announcements.md)，每版部署核验见 [app/docs/releases/](app/docs/releases/)。

## 目录结构

```text
app/       唯一维护目录：Node 服务 + React/Vite 前端 + Docker 配置 + 文档
audit/     历次发布与审计的核验记录
research/  调研材料与第三方开源项目副本（许可证见各自目录）
staging/   115 备份运行时等构建材料
release/   各版本发布清单与核验证据（不入库，本地留存）
```

## 许可证

自研代码（`app/`、`audit/`、`docs/` 等）以 [MIT License](LICENSE) 发布；`research/` 内的第三方项目副本分别遵循其原始许可证（MIT / GPL-3.0，见各自目录的 LICENSE 文件）。
