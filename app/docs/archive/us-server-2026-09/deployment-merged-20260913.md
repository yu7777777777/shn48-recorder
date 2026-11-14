# 两列合并与翻牌 · 2026-09-13

已部署 <US_SERVER_IP>，镜像 shn48-shn48:merged-20260913（c73c233044af），资源 index-Bw2CqNDB.js。
房间导航仅显示成员名字；成员列合并聊天与通知，按时间降序排列，两来源独立游标，部分错误明确显示。通知紫色，成员发言蓝色。
实测王睿琦通知接口包含翻牌 question/answer，支持文本和 JSON 音频地址解析、提问引用及播放器。
验证：Chromium 两列、通知合并、刷新、历史分页及响应式检查通过；翻牌文字/音频解析检查通过。生产健康和前端资源检查通过，录像/上传队列校验一致。
回滚镜像 shn48-shn48:rollback-merged-20260913；备份 /opt/backups/shn48-merged-20260913；发布 /opt/shn48-releases/merged-20260913。保留最新运行数据。
