# 同手机号主号／小号接口调查

已确认的第三方客户端实现：
- https://github.com/duan602728596/48tools/blob/b37ee486d77cb535b1220c29f3d947a6dc39c88e/packages/48tools/src/services/48/login/index.ts
- https://github.com/NannaOlympicBroadcast/pocket48-cli/blob/1dcbf2f08c69d12b1aab9fe6d07790cf58719588/src/main/services/pocket-service.js

读取 POST /user/api/v1/user/info/reload，body {from:"appstart"}。返回 content.bigSmallInfo.bigUserInfo 和 smallUserInfo；当前身份为 content.userId。
切换 POST /user/api/v1/bigsmall/switch/user，body {toUserId:目标ID}。使用当前 Token，成功后保存返回的新 Token。

本项目接入：账号卡片显示主号／小号；只允许切换上游返回的关联账号；同一身份不发切换请求；切换前后核对当前凭据，避免覆盖并发更新的账号；只保存确认返回目标 UID 的成功结果；界面不输出 Token；切换后清空旧消息监听。

微信调查：上述两个项目未提供口袋48微信授权接入。pocket48-cli 的二维码登录只用于 live.48.cn，不产生口袋48 Token。官方隐私政策确认 App 使用微信授权，但未公布网页授权及兑换口袋48 Token 的接入契约。官方下载接口重定向的 APK 当前返回 404。因此未添加不可用微信按钮，未伪造 AppID 或回调。后续需要可分析的官方客户端安装包、官方接口资料或用户本人授权登录的脱敏请求记录来确认协议；接口发现本身不保证网站可完成微信授权。
