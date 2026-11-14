# 1.31.2 本地发布整理（准备发布）

日期：2026-10-30。仅本地操作，未访问生产、未执行部署。线上基线由 lead 已确认，本报告不另行作线上健康承诺。

## 版本与范围

- 按 AGENTS 与用户要求，预读脚本全部目标后，在 app 工作目录运行 bundled Node `scripts/version.mjs set 1.31.2`，未重复 set。
- set 之前仅对齐脚本无法识别的旧文本元数据：Dockerfile/Compose 的 1.30.1 与应用 README 当前标题/简介的 1.31.0 对齐至原 VERSION 1.31.1；smoke-test 原无版本字面量，新增版本契约注释以满足原 check，不改冒烟逻辑。
- set 统一更新 client/server package 与 package-lock 根版本（旧锁根版本 1.31.0）；未运行安装、锁文件生成或依赖升级。应用 CSS 仅由版本脚本修改头部版本注释，不改业务样式。未改后端业务代码。
- CHANGELOG 新增 1.31.2 正式条目，根 README 标识 1.31.2 准备发布并明确线上仍 1.31.1，不宣称部署完成。

## 验证结果

- version check：PASS，见 version-check.utf8.log。
- Vite production build：PASS，154 modules，2.75 秒；存在既有 hls chunk 大于 500 kB 告警，不影响 exit 0，见 vite-build.utf8.log。
- 全量客户端：136 tests / 136 pass / 0 fail / 0 skip，耗时约 53.34 秒，exit 0，见 client-test.utf8.log。CHROMIUM_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe，bundled Node，--test --test-concurrency=4。日志保留并行夹具的 Vite HMR 24678 占用和 dep-scan 关闭噪声，未过滤或篡改。
- frontend-VERSION.SHA256SUMS：46 个文件（45 个 dist 文件与 VERSION）。本地构建完成后不再改 dist，交由 lead 制作 overlay。
- 两个 package.json 除正式版本/description 版本字段外与预存快照一致。两个锁文件全依赖比较不可用：manifests-before.json 由 read 大文件返回拼接，其内容被截断后仍可解析，造成错误差异；metadata-integrity.log 是该无效基线比较失败记录，不代表实际依赖被改。metadata-integrity-final.log 明示此限制，不虚报全依赖比较通过。锁文件实际只由已预读的 version.mjs 写入根版本，未再手改。

## 交接

生产发布必须使用线上实际运行镜像为基底，仅覆盖获准的前端 dist、VERSION 与版本包元数据；严禁把本地 server 树打进 overlay。本次未访问生产，未改配置/凭据/运行数据。lead 负责最终打包、部署与线上核验。
