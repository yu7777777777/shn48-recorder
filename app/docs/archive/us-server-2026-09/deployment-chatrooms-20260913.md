# 成员与粉丝消息接入 · 2026-09-13

已通过服务器管理 MCP 发布至 <US_SERVER_IP> /opt/shn48。
镜像 shn48-shn48:chatrooms-20260913（69b7f80cff13），前端 index-fi5jfjWL.js。

原因：conversation/page 的 targetId 是旧会话 ID，不能作为 QChat channelId。旧接口返回直播通知，不是完整聊天流。
修复：通过公开 https://data.gnz.hk/members.json 按 ownerId 映射 channelId 和 serverId，缓存一小时；不向索引站发送账号凭据。默认读取 team/message/list/homeowner，全部消息使用 team/message/list/all，直播通知保留独立入口。映射缺失或索引请求失败明确报错，不再回退成直播通知冒充成员消息。监听默认读取成员消息。

页面支持三类切换、历史分页、真实用户昵称以及图片/音频/视频展示。按 msgIdClient 去重。

验证：5 项后端相关测试、3 项前端格式测试通过；隔离 Chromium 验证成员正文、历史翻页、粉丝消息、通知及切换清空行为通过。生产只读查询陈琳房间 67207851 → channelId 1279493 / serverId 1213951，成员 50 条、成员下一页 50 条、全部 50 条、通知 2 条，HTTP/业务状态均为 200。服务健康，新前端资源生效，录像和上传队列 SHA256 一致。

发布 /opt/shn48-releases/chatrooms-20260913，备份 /opt/backups/shn48-chatrooms-20260913/source-before.tar.gz，回滚镜像 shn48-shn48:rollback-chatrooms-20260913。回滚仅恢复代码与镜像，保留最新运行数据。
