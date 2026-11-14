# 阿里云迁移 · 2026-09-13

主服务已迁移至 <SERVER_IP> /opt/shn48，镜像 shn48-shn48:danmaku-fix-20260913，ID 4f7ef2ebfa8c403711ad8e7d7e3a7380e84b9441c580ee4de01cac4a4d328d59。
41 条录像记录、20 条上传记录、3.8 GB 录像和账号/签到配置已迁移。运行数据逐文件 SHA256 校验通过，切换前停旧实例后 rsync checksum 增量同步；最终 recordings/upload_queue/auto-checkin 校验一致。
阿里云 Docker/Compose 已安装；Compose 文件适配 3.3 格式并显式指定镜像，不使用美国 egress 配置。软件源备份 /opt/shn48-migration/sources.list.before；停用失效 backports，普通源改公共阿里镜像、安全源改官方。
5 项镜像隔离测试通过，生产健康正常，口袋账号有效、30 个房间、弹幕接口成功、自动签到开启。剩余磁盘约30GB。
美国旧容器 exited，restart=no，原数据保留。阿里云公网3000外部超时但本机正常，需云安全组放行TCP3000。临时旧入口 http://<US_SERVER_IP>:3000 由 systemd shn48-migration-access.service SSH 转发至阿里云 localhost:3000；只转发网站访问，录制/上传直接在阿里云执行。旧入口外部健康验证通过。
新入口应为 http://<SERVER_IP>:3000，放行后再移除临时转发。不得同时启动两个主服务。回滚先停阿里云实例、同步最新数据回美国，再停转发并恢复美国容器重启策略与启动；不能直接使用旧数据覆盖新数据。

## 旧服务器清理
用户确认新端口放行并授权清理后，公网新地址健康检查通过。美国端旧容器、专用镜像标签、shn48-web网络、/opt/shn48、迁移包、发布目录和 shn48-* 备份已删除；临时入口转发及旧出口隧道停用，专用密钥/脚本/服务文件已删除。其他运行服务保持正常。旧地址已不再转发，回滚旧副本不再可用。清理前阿里云41条记录为25 deleted、16 merged，无实际视频文件，未将美国旧录像恢复。新端健康检查再次通过。
