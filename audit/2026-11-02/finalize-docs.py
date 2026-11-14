from pathlib import Path
import json,re,tarfile
root=Path(__file__).resolve().parents[2];app=root/'app';audit=Path(__file__).resolve().parent
deployment=json.loads((audit/'deploy-result-patch.json').read_text())
assert deployment['health']['data']['version']=='1.32.1' and deployment['healthStatus']=='healthy'
public=json.loads((audit/'public-verification.json').read_text())
assert public['health']['data']['version']=='1.32.1' and public['frontendAssetsVerified']==48
browser=json.loads((audit/'production-1.32.1/results.json').read_text());assert len(browser)==8 and all(not r['errors'] and not r['overflow'] for r in browser)
with tarfile.open(audit/'evidence-patch.tar.gz') as archive:
 start=archive.extractfile('cutover-start.txt').read().decode().strip()
 end=archive.extractfile('cutover-complete.txt').read().decode().strip()
report=f'''# 1.32.1 发布核验

## 结果

- 2026-11-02，阿里云 `/opt/shn48`，容器 `shn48-recorder`。切换开始 `{start}`，健康与哈希确认 `{end}`（北京时间）。
- 镜像 `shn48-shn48:1.32.1`，ID `{deployment['imageId']}`；公开健康接口 `ok / 1.32.1`，容器 healthy、RestartCount=0。
- 263 个运行文件 SHA-256 一致，公网全部 48 个前端资源 SHA-256 一致；五个管理接口未登录返回 401，日报与 RSS 接口正常。
- `.env`、配置及管理员凭据哈希不变，四个运行挂载不变，{deployment['archiveMainFilesUnchanged']} 个当前归档主文件的路径、大小、mtime、inode 不变。健康后已停止/created 容器为空，额外清理 0 个；未执行全局 prune。

## 范围与验证

- 1.32.0 新增第三项公开导航后，390px 手机顶部向右溢出约 6px；本补丁将换行阈值由 380px 提至 420px，导航自身允许横向滚动。
- 兼容 CSS 修复按 PATCH 升为 1.32.1。以前一版实际运行镜像为基底，仅替换前端构建、VERSION 和服务端包版本元数据；全部后端业务文件哈希不变，未更新依赖。
- 版本检查和生产构建通过；候选真实 ENTRYPOINT、登录鉴权及新增接口冒烟通过；320/360/390/420/430/768/1440px 的直播和日报共 14 个布局场景通过。
- 真实公网 Chrome 桌面 1440px、手机 390px 下的直播列表、重播列表、总结日报、登录页共 8 个场景通过：无 pageerror、无整页横向溢出，并保存截图。
- 1.32.0 后端 571 项及前端 166 项全量测试中的测试夹具/语言环境问题与选择性重跑结果见 [1.32.0 核验](1.32.0-audit.md)。本补丁没有重复整套业务测试。
- 通知默认关闭；未在生产发起录制、投稿、115 上传、付费 AI 或外部通知。生产总结发布开关保留原设置，日报当前显示未开放。
- 发布包 `release/1.32.1/shn48-1.32.1-frontend-patch.tar.gz`，135 个源码/元数据文件，SHA-256 `c6a057b92fd893ec5a55d9fd7ffe26483dd2846164b6c4b1380261a2f657216e`。

## 切换与回滚

- 首次切换因一项正在进行的回放校验而被保护检查拦下，未停止服务；等待任务结束后才执行补丁切换。
- 回滚镜像 `shn48-shn48:rollback-1.32.0-20261102` 保留；更早的 `rollback-1.31.2-20261102` 也保留。
- 回滚脚本 `/opt/shn48/releases/1.32.1/rollback.sh`；执行前检查活动任务。元数据快照在服务器 `/opt/shn48/backups/release-1.32.1-20261102`，未把凭据放入源码包或本地证据包。
- 证据：本地 `audit/2026-11-02/evidence-patch.tar.gz`、`public-verification.json`、`production-1.32.1/`；服务器 `/opt/shn48/releases/1.32.1/`。
'''
(app/'docs/releases/1.32.1-audit.md').write_text(report,encoding='utf8')
changelog=(app/'CHANGELOG.md').read_text(encoding='utf8')
changelog=changelog.replace('### 修复\n\n- 发布后真机尺寸核验',f'### 修复\n\n- 已部署阿里云并通过健康、263 个运行文件及公网 48 个前端资源核验；{deployment["archiveMainFilesUnchanged"]} 个录像主文件与账号配置保持不变，清理无用旧容器 0 个，保留回滚。详见 `docs/releases/1.32.1-audit.md`。\n- 发布后真机尺寸核验',1)
head,tail=changelog.split('## [1.31.2]',1)
head=head.replace('（同轮追加，未发布）','（同轮追加）').replace('（未发布）','')
head=head.replace('尚未发布。','已随 1.32.0 发布。').replace('发布时应升 MINOR。','已随 1.32.0 以 MINOR 发布。')
head=head.replace('发布时升 MINOR（`node scripts/version.mjs set 1.32.0`）。','已随 1.32.0 以 MINOR 发布。')
head=head.replace('未升版本号。','开发阶段未单独升版，已并入 1.32.0 发布。')
(app/'CHANGELOG.md').write_text(head+'## [1.31.2]'+tail,encoding='utf8')
readme=(app/'README.md').read_text(encoding='utf8')
readme=re.sub(r'\*\*未发布（见 CHANGELOG Unreleased，发布时升 [^）]+）\*\*','**1.32.0 新增功能（已上线，当前补丁 1.32.1）**',readme)
(app/'README.md').write_text(readme,encoding='utf8')
readme=(root/'README.md').read_text(encoding='utf8')
notice='**2026-11-02 线上发布 1.32.1**：已上线两轮 25 项修复及八项新功能，并修复新增日报导航的手机溢出。容器健康、重启 0；263 个运行文件与公网 48 个前端资源哈希一致，账号配置和录像主文件保持不变，回滚材料保留。详见 [1.32.0 发布核验](app/docs/releases/1.32.0-audit.md) 与 [1.32.1 补丁核验](app/docs/releases/1.32.1-audit.md)。'
readme=readme.replace('# 48tools 录制服务\n','# 48tools 录制服务\n\n'+notice+'\n',1)
readme=re.sub(r'当前正式版本与线上已核实版本：\*\*[^*]+\*\*','当前正式版本与线上已核实版本：**1.32.1**',readme,count=1)
readme=re.sub(r'\*\*未发布概览\*\*：[^\n]+','**本轮更新已发布**：25 项字幕、回放、上传、存储及体验修复，以及通知、字幕搜索、AI 高光切片、弹幕高能、关键词监控、总结日报/RSS、真实转码和 AI 投稿文案八项新增，已并入 1.32.0；手机导航补丁为 1.32.1。后续未发布内容以 [CHANGELOG Unreleased](app/CHANGELOG.md) 为准，迁移历史与后续差距见[任务板](app/docs/pocket48-summarizer-migration.md)。',readme,count=1)
table='| --- | --- | --- | --- | --- |'
rows='\n| 1.32.1 | 2026-11-02 | — | 修复三项公开导航在手机 390px 宽度下溢出；14 项候选布局场景与 8 项公网桌面/手机场景通过 | [核验](app/docs/releases/1.32.1-audit.md) |\n| 1.32.0 | 2026-11-02 | 通知、搜索、高光切片、弹幕高能、关键词、日报/RSS、转码、AI 投稿文案 | 两轮 25 项体验及可靠性修复；补齐缺失通知模块，修正测试夹具 | [核验](app/docs/releases/1.32.0-audit.md) |'
readme=readme.replace(table,table+rows,1)
(root/'README.md').write_text(readme,encoding='utf8')
diagnosis=audit/'未部署更新核对.md'
diagnosis.write_text(diagnosis.read_text(encoding='utf8')+'\n## 后续处理\n\n2026-11-02 已补全缺失通知模块，完成验证并发布 1.32.0，随后发布手机导航补丁 1.32.1。当前线上已与本地正式版本对齐，详见 app/docs/releases/1.32.1-audit.md。\n',encoding='utf8')
print('FINAL_RELEASE_DOCS_UPDATED')
