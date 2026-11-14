# 口袋48工作台部署 · 2026-09-12

已部署至 <US_SERVER_IP> /opt/shn48。
入口：http://<US_SERVER_IP>:3000/admin/pocket48
镜像：shn48-shn48:pocket48-20260912
镜像 ID：ccb52d8644710bbcd9d3bc77d86a6962d9f21da68101dda5b79814a8c9be38f9
前端：index-DUUKKWcU.js / index-CqE3QaAH.css。

服务器隔离镜像测试 63/63 通过，无跳过；本地浏览器模拟交互测试通过。公网页面与健康接口返回 200，新账号接口匿名访问返回 401。切换时无进行中的录像或上传，切换前后 recordings.json 和 upload_queue.json 校验一致。原有数据、凭据、配置和录像挂载保留。

只读检测：已保存的口袋48凭据仍被上游拒绝（health=invalid），需要用户通过短信重新登录。未发送短信、执行真实签到或读取私人房间消息。

回滚镜像：shn48-shn48:rollback-pocket48-20260912
备份目录：/opt/backups/shn48-pocket48-20260912
发布包、构建与测试日志：/opt/shn48-releases/pocket48-20260912
沿用 docker-compose.yml、docker-compose.public.yml、docker-compose.egress.yml，仅更新 shn48 服务。回滚应使用旧镜像并保留最新运行数据，不用备份覆盖新增录像和上传历史。
