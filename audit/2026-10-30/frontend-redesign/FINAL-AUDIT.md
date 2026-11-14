# 前端美化独立浏览器截图验证（最终构建）

验证时间：2026-10-30 16:52:58–16:53:18（Asia/Shanghai）。

最终证据目录：[run-2026-10-30T08-52-58-494Z](run-2026-10-30T08-52-58-494Z/REPORT.md)。原始指标与45个dist文件SHA-256：[results.json](run-2026-10-30T08-52-58-494Z/results.json)。

## 结果

- 当前最终dist共16个场景全部通过：8页面 × 1440×1000 / 390×844。
- 页面：直播列表、回放列表、回放详情、后台总览、自动录制、口袋48、录像归档、管理员登录。
- pageerror、console error、console warning、HTTP错误、failedRequests、外部请求：全部0；页面级横向溢出0。
- 17张PNG：每场景一张，另有390px导航抽屉。口袋48场景点击成员并校验消息渲染。
- Chrome 156.0.8078.49 / bundled Node v24.21.0；HTTP临时服务只绑定127.0.0.1随机端口，退出时关闭浏览器和所有HTTP连接。最终job pwsh-81702140bc4c4634退出0且已收集输出。

## 可复现命令

从仓库根目录使用PowerShell执行：

    & "C:/Users/Administrator/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node.exe" audit/2026-10-30/frontend-redesign/visual-smoke.cjs

脚本默认读取 app/client/dist，不构建、不启动真实应用server。依赖从 app/server/package.json 解析现有express/playwright；Chrome默认 C:/Program Files/Google/Chrome/Application/chrome.exe。可通过 AUDIT_DIST / CHROMIUM_PATH 环境变量覆盖路径。每次仅新建审计目录下run-时间戳，不覆盖证据。

## 发现与限制

- 未发现当前mock数据下页面运行时异常或整页横向溢出。390px总览的宽表格和口袋48成员条在各自容器内横向滚动，非整页溢出；口袋48第二成员需要横滑，team名称换行。截图如实保留此现状，可作为移动端可发现性的后续优化项，不在本次审计改源码。源码Pocket48.css的243–254行明确指定移动端横向成员条。
- 回放详情刻意不返回playUrl，因此截图显示“播放接口没有返回播放地址”，验证错误态布局、详情、公开总结及近期列表；这不是生产故障，也不声称真流播放/下载通过。
- 所有数据为虚构本地mock；本地认证仅用于展示后台，不验证真实鉴权、上游账号、录制、下载或115备份。缺省图片为空，覆盖团体彩色fallback，不访问外部图片。
- 已复用 archive-layout.test.js、pocket48-ui.test.js 的express随机端口、app/server Playwright、真实Chrome与finally清理模式；补读公开回放总结UI测试与页面API契约。
- 初始 run-2026-10-30T08-50-33-449Z 用于脚本调试：12/16，四个失败来自归档backup115未mock及登录页被mock authenticated:true重定向；已修正fixture并对最终dist重新完整执行。请勿把初始截图作为最终证据。最初一次PowerShell路径转义失败未启动浏览器；该job亦已收集，不影响最终结果。

## 代表截图

- [直播列表1440px](run-2026-10-30T08-52-58-494Z/live-list-1440.png)
- [回放列表1440px](run-2026-10-30T08-52-58-494Z/replay-list-1440.png)
- [回放详情390px](run-2026-10-30T08-52-58-494Z/replay-detail-390.png)
- [后台总览1440px](run-2026-10-30T08-52-58-494Z/admin-overview-1440.png)
- [自动录制390px](run-2026-10-30T08-52-58-494Z/admin-auto-record-390.png)
- [口袋48桌面](run-2026-10-30T08-52-58-494Z/admin-pocket48-1440.png)
- [口袋48移动端](run-2026-10-30T08-52-58-494Z/admin-pocket48-390.png)
- [移动导航](run-2026-10-30T08-52-58-494Z/admin-mobile-menu-390.png)

本任务仅在 audit/2026-10-30/frontend-redesign/ 下新建审计文件，未修改源码、测试、项目文档、dist或任何生产环境。
