# 封面功能部署 · 2026-09-12

服务器：<US_SERVER_IP>，目录 /opt/shn48。
镜像：shn48-shn48:covers-20260912。
镜像 ID：ede86125d39a158f28eec88697c5b1ffa6bbb29a0b21e758b2fe665f33a03711。
前端：index-BGQvVGpE.js / index-DI6JIVlO.css。

服务器镜像 60/60 后端测试通过，无跳过，包含真实 FFmpeg 封面生成和模拟 B站封面上传。原有 3 份已归档录像已补生成本地封面，未修改远端旧草稿。录像其余字段和上传历史均保持一致。服务健康、公开入口返回 200，匿名封面接口返回 401。

回滚镜像：shn48-shn48:rollback-covers-20260912。
备份：/opt/backups/shn48-covers-20260912（源代码和切换时状态）。
发布包和测试日志：/opt/shn48-releases/covers-20260912。

使用原有三个 Compose 文件切换，仅更新 shn48 服务。回滚时保留最新运行数据，不用旧状态覆盖新增录像或上传历史。真实 B站封面写入由后续新投稿验证，本次未进行额外生产投稿。
