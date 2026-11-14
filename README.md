# 48tools 录制服务

私有部署的口袋48 直播录播中枢：从直播发现、自动录制、归档剪辑，到 AI 字幕分析与 B 站投稿的完整工作台。公开页面展示直播与官方回放；录制、归档、投稿等管理能力全部在管理员登录之后。

> 本项目为个人自用的粉丝工具，与 SNH48 GROUP / 丝芭传媒 / 口袋48 官方无关。

## 主链路

```text
口袋48直播发现 → 网页实时播放 → 自动录制 → 归档合并 → 选段剪辑 → B站草稿
                                    ↓
                        离线 ASR 转写 → AI 总结 / 章节 / 高光
```

## 功能总览

**录制与归档**

- 自动录制：选择成员启用，按场轮询并发录制（1–20 场），断流 5 分钟内自动合并为同一场，杜绝重复归档
- 归档主文件 MP4 完成时长核验与完整解码检查；原始 FLV 保留以便恢复
- 磁盘水位清理：低于保留线自动回收原始片段与缓存，**归档主文件永不自动删除**
- 官方回放修复：重连直播时间轴无损拼接、逐段解码核验，"已修复 · 官方源受限"明确标注未补回内容

**剪辑与 AI 分析**

- [剪辑工作台](app/docs/recording-workbench.md)：标记时间、预览片段、后台生成 MP4、下载或送入 B 站草稿
- [离线识别与 AI 文字纠错](app/docs/offline-asr.md)：tiny/base 模型服务器本地转写，词库纠错保留原文对照
- AI 总结：章节、精彩片段、翻译；弹幕密度峰值参与高光判定，播放器下方高能条可点击跳转
- AI 高光一键切片：精彩片段合成合集或逐段成片；跨归档字幕全文搜索，"这句话是哪场直播说的"
- 真实转码导出：横屏 / 竖屏 / 仅音频，可选烧录字幕

**发布与备份**

- B 站草稿队列：单并发上传、断点续传，AI 生成"成员 + 日期 + 主题"的投稿标题简介
- 115 网盘备份：离线识别异步上传、SHA-256 校验

**公开页面**（无需登录）

- 当前直播、口袋48 官方成员回放、已发布总结的[日报与 RSS](app/docs/recording-workbench.md)
- 成员社交账号聚合页（访问码控制）

**运维与自动化**

- 外部通知推送：开始录制 / 归档 / 投稿 / 备份 / 分析完成与失败推送到 Telegram、邮件（SMTP）、Server酱、Bark、Webhook；连续失败按域告警带冷却
- 口袋48消息关键词监控：命中即触发通知
- 自动签到、成员真实关注 / 取关
- **版本自动更新**：定时比对 GitHub 仓库发布版本与运行版本，新版本经通知提醒，人工确认后在服务器一条命令完成「拉取 → 源码核验 → 构建 → 切换 → 健康与运行文件哈希核验 → 失败自动回滚」（公开仓库全程零凭据）

## 快速开始

```bash
cp app/.env.example app/.env        # 填入 ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET
cd app
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d
curl http://127.0.0.1:3000/api/public/health
```

完整步骤（配置口袋48账号、B站扫码登录、115 授权、自动录制、ASR 模型下载）见[部署指南](app/docs/deployment-guide.md)。

## 安全边界

单一 Node 服务，接口严格分层：`/api/public/*` 只读且无登录态；`/api/admin/*` 全部由后端验证管理员会话；改密接口额外验证当前密码。会话凭据、B站 Cookie、115 授权、通知渠道密钥均只存服务器数据目录。

## 文档

| 文档 | 内容 |
|---|---|
| [app/README.md](app/README.md) | 系统详解：主链路细节、安全边界、各版本能力说明 |
| [部署指南](app/docs/deployment-guide.md) | 从零部署、账号配置、数据迁移 |
| [剪辑工作台](app/docs/recording-workbench.md) | 归档详情、片段标记、公开分享 |
| [离线 ASR](app/docs/offline-asr.md) | 模型下载、词库纠错、翻译管线 |
| [115 备份设计](app/docs/115-backup-design.md) | 备份 worker、校验与恢复 |
| [发布流程](app/docs/release-process.md) | 版本号、测试、清单、部署核验约定 |
| [更新记录](app/CHANGELOG.md) | 全部版本变更 |
| [公开前检查清单](PUBLIC-CHECKLIST.md) | 仓库公开化的内容约束 |

## 更新记录

当前正式版本：**1.34.0**（以 [app/VERSION](app/VERSION) 为准）。`Unreleased` 段记录未发布内容；历次发布的详细变更见 [app/CHANGELOG.md](app/CHANGELOG.md)， narrative 式发布公告存档见 [docs/release-announcements.md](docs/release-announcements.md)，每版部署核验见 [app/docs/releases/](app/docs/releases/)。

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
