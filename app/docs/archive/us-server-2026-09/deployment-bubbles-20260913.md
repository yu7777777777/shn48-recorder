# 三列气泡消息 · 2026-09-13

已部署 <US_SERVER_IP> /opt/shn48，镜像 shn48-shn48:bubbles-20260913（d47a0aba9c21），前端 index-BPNevvBA.js。

成员消息、成员＋粉丝、直播消息三列同时展示，独立加载/错误/刷新/分页；按房间重新挂载避免旧请求串入新房间。气泡、昵称、时间及媒体展示；窄桌面房间导航置顶，手机三列纵向排列。

构建通过。隔离 Chromium 验证三列同时加载、独立刷新和历史分页通过；1440/1000/390 宽度无页面横向溢出。生产健康检查与新资源检查通过，录像和上传队列 SHA256 一致。

发布 /opt/shn48-releases/bubbles-20260913，备份 /opt/backups/shn48-bubbles-20260913/source-before.tar.gz，回滚镜像 shn48-shn48:rollback-bubbles-20260913。回滚保留最新运行数据。
