# 前端美化独立浏览器截图审计

- 时间：2026-10-30T08:50:33.466Z
- 构建目录：D:\飞牛同步\AI资料库\AI项目空间\shn48录制\app\client\dist
- Chrome：156.0.8078.49
- Node：v24.21.0
- 场景：16，通过：12，失败：4
- 绑定127.0.0.1随机端口；测试进程内服务；finally关闭Chrome与HTTP服务。
- 不启动生产server、不连接生产、不读取凭据、不修改源码/测试/文档/dist。

## 可复现命令

从仓库根目录执行（PowerShell）：

    & "C:UsersAdministrator.dshdsh-runtimesdsh-plugin-desktop-primary-runtimedependencies
odein
ode.exe" audit/2026-10-30/frontend-redesign/visual-smoke.cjs

可选环境变量：CHROMIUM_PATH指定Chrome；AUDIT_DIST指定待验证dist。每次运行新建run-时间戳目录，避免覆盖历史证据。先由lead完成最终前端构建，再执行相同命令。

## 限制

- API为固定虚构数据，认证仅本地mock，不验证真实鉴权/接口/录制任务。
- 无媒体流；回放详情截图中的“播放接口没有返回播放地址”为明确模拟的无流状态，不是生产故障。
- 缺省图片为空，覆盖团体色封面和头像fallback；不访问外部图片。

## 页面与截图

- live-list / 1440px：PASS；截图 [live-list-1440.png](live-list-1440.png)；pageerror 0；console error 0；横向溢出 false
- replay-list / 1440px：PASS；截图 [replay-list-1440.png](replay-list-1440.png)；pageerror 0；console error 0；横向溢出 false
- replay-detail / 1440px：PASS；截图 [replay-detail-1440.png](replay-detail-1440.png)；pageerror 0；console error 0；横向溢出 false
- admin-overview / 1440px：PASS；截图 [admin-overview-1440.png](admin-overview-1440.png)；pageerror 0；console error 0；横向溢出 false
- admin-auto-record / 1440px：PASS；截图 [admin-auto-record-1440.png](admin-auto-record-1440.png)；pageerror 0；console error 0；横向溢出 false
- admin-pocket48 / 1440px：PASS；截图 [admin-pocket48-1440.png](admin-pocket48-1440.png)；pageerror 0；console error 0；横向溢出 false
- admin-archive / 1440px：FAIL；截图 [admin-archive-1440.png](admin-archive-1440.png)；pageerror 0；console error 1；横向溢出 false
- admin-login / 1440px：FAIL；截图 [admin-login-1440-failure.png](admin-login-1440-failure.png)；pageerror 0；console error 0；横向溢出 undefined；locator.waitFor: Timeout 12000ms exceeded.
- live-list / 390px：PASS；截图 [live-list-390.png](live-list-390.png)；pageerror 0；console error 0；横向溢出 false
- replay-list / 390px：PASS；截图 [replay-list-390.png](replay-list-390.png)；pageerror 0；console error 0；横向溢出 false
- replay-detail / 390px：PASS；截图 [replay-detail-390.png](replay-detail-390.png)；pageerror 0；console error 0；横向溢出 false
- admin-overview / 390px：PASS；截图 [admin-overview-390.png](admin-overview-390.png)；pageerror 0；console error 0；横向溢出 false
- admin-auto-record / 390px：PASS；截图 [admin-auto-record-390.png](admin-auto-record-390.png)；pageerror 0；console error 0；横向溢出 false
- admin-pocket48 / 390px：PASS；截图 [admin-pocket48-390.png](admin-pocket48-390.png)；pageerror 0；console error 0；横向溢出 false
- admin-archive / 390px：FAIL；截图 [admin-archive-390.png](admin-archive-390.png)；pageerror 0；console error 1；横向溢出 false
- admin-login / 390px：FAIL；截图 [admin-login-390-failure.png](admin-login-390-failure.png)；pageerror 0；console error 0；横向溢出 undefined；locator.waitFor: Timeout 12000ms exceeded.

## 发现

- admin-archive 1440px: {"pageErrors":[],"consoleErrors":["Failed to load resource: the server responded with a status of 501 (Not Implemented)"],"httpErrors":[{"url":"http://127.0.0.1:21346/api/admin/backup115/","status":501}],"layout":{"viewport":1440,"documentWidth":1440,"bodyWidth":1440,"horizontalOverflow":false,"overflowElements":[]}}
- admin-login 1440px: locator.waitFor: Timeout 12000ms exceeded.
Call log:
[2m  - waiting for locator('input').first() to be visible[22m

    at run (D:\飞牛同步\AI资料库\AI项目空间\shn48录制\audit\2026-10-30\frontend-redesign\visual-smoke.cjs:78:161)
- admin-archive 390px: {"pageErrors":[],"consoleErrors":["Failed to load resource: the server responded with a status of 501 (Not Implemented)"],"httpErrors":[{"url":"http://127.0.0.1:21346/api/admin/backup115/","status":501}],"layout":{"viewport":390,"documentWidth":390,"bodyWidth":390,"horizontalOverflow":false,"overflowElements":[]}}
- admin-login 390px: locator.waitFor: Timeout 12000ms exceeded.
Call log:
[2m  - waiting for locator('input').first() to be visible[22m

    at run (D:\飞牛同步\AI资料库\AI项目空间\shn48录制\audit\2026-10-30\frontend-redesign\visual-smoke.cjs:78:161)

构建文件SHA-256、全部请求错误、页面文本、溢出元素和环境详情见 results.json。