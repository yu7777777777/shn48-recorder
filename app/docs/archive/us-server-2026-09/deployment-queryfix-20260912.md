# 签到与房间查询修复 · 2026-09-12

已部署 <US_SERVER_IP> /opt/shn48，镜像 shn48-shn48:queryfix-20260912，ID e8269e5d6136c53ca54cd3146e3bf0591991d2ec630b5725e8b45451d6ccbe30，前端 index-DTetQu_8.js。

原因：旧 /checkin/info 与 /chatroom/list 不适用；前端未识别真实 hasCheck 字段；房主消息未携带 ownerId。
修复：签到改用 /checkin/check/today；房间列表改用 /conversation/page，取最多 100 个近期会话中的房间类型并输出白名单字段；消息携带该房间 ownerId；手动频道通过 room/info 获取 serverId 后读取 team/message/list/homeowner。404 与其他业务错误分开显示，已登录时的失败状态不再提示去登录。

验证：65/65 服务器隔离测试通过，2/2 浏览器测试通过。生产当前账号只读实测 authenticated=true、hasCheck=true、1 个会话，房主消息查询成功返回 0 条。未执行真实签到或切换账号。生产录像与上传历史校验一致。

回滚 shn48-shn48:rollback-queryfix-20260912，备份 /opt/backups/shn48-queryfix-20260912，发布 /opt/shn48-releases/queryfix-20260912。保留最新运行数据回滚。
