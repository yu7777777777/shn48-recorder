# B站草稿删除

草稿卡片新增红色「删除」按钮，点击后弹出显示稿件标题的二次确认。删除只影响当前 B站账号的指定草稿；服务器录像、上传历史和去重标记保留，不会触发重新上传。测试仅针对模拟接口，不删除生产草稿。

## 安全边界

- 管理员登录与 `confirmed: true` 必须同时存在。
- 只接受正整数草稿 ID，不接受标题、列表序号、AV/BV/CID 替代。
- 操作前只读核实当前账号草稿列表，找不到时不调用删除接口。
- 缺失 B站登录/CSRF 凭据时拒绝；同一草稿进行中拒绝重复请求。
- B站必须返回 HTTP 200 和业务 code 0 才显示成功。
- 超时不自动重试，不伪造删除成功；提示先刷新确认远端状态。
- 页面列表获取失败时显示明确错误，不以旧卡片代替实时结果。

## 接口核验

2026-09-04 只读核验 B站创作中心发布的前端脚本：

- [请求封装](https://s1.hdslb.com/bfs/static/studio/creativecenter-platform-next/static/js/js/creativecenter-v3.index.d4ab5158.js)：POST `/x/vupre/web/draft/delete`，表单、Cookie 与 CSRF。
- [草稿卡片调用](https://s1.hdslb.com/bfs/static/studio/creativecenter-platform-next/static/js/async/js/creativecenter-v3.5421.d4ab5158.js)：`delDraft({id})`。

## DesignBuild

```json
{"aesthetic":"延续现有极简浅色管理卡片","fonts":["保留现有字体"],"palette":["现有背景与边框变量","现有 danger 红色"],"motions":["复用确认框动效"],"code_blocks":["client/src/pages/Bilibili.jsx","client/src/App.css"]}
```

浏览器自动测试覆盖：取消不发请求；缺少 ID 禁止删除；上游失败保留卡片；成功只移除指定 ID 并刷新数量；手机宽度不横向溢出。服务器测试检查真实 HTTP 路由鉴权、确认、重复请求、表单参数与本地录像/历史不变。

## 部署结果

已部署至 `<US_SERVER_IP>` 的 `/opt/shn48`。镜像 `shn48-shn48:draft-delete-20260904`，ID `d211080321e1a23941091738203ed6ba6393f153dfff2f5222be7677599d0411`。最终镜像 57/57 后端测试通过、无跳过；浏览器模拟交互测试通过。

公网页面及健康接口 HTTP 200；未登录删除请求 HTTP 401。部署后只读复核 B站仍有 13 条草稿；录像状态文件及上传历史文件校验和与重启前一致。没有对生产账号执行已鉴权的删除测试。

回滚镜像为 `shn48-shn48:rollback-draft-delete-20260904`；代码备份在 `/opt/backups/shn48-draft-delete-20260904/source-before.tar.gz`。本次仅覆盖补丁中的文件，配置、凭据、录像及其他应用均未修改。
