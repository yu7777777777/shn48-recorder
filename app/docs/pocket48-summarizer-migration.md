# Pocket48 Replay Summarizer 迁移任务板

## 基线与原则

- 上游：[RuokeZhang/pocket48-summarizer](https://github.com/RuokeZhang/pocket48-summarizer)，核验提交 `d5f45afeef1766e16525393e1beb13d24b2452ba`（2026-10-22 核验，MIT）。
- 当前正式版本以 `app/VERSION` 为准，第二轮核查已由并发维护更新为 1.27.7（独立录制启动修复）；本迁移仍停留 Unreleased，未随本会话部署，不覆盖并发发布条目，不改变现有生产 Docker/录制/归档/备份行为。
- 采用 Node/React 原生集成，不直接覆盖 Python/FastAPI/SQLite 或上游 systemd 部署脚本。
- 上游 MIT 原文保留于 `docs/pocket48-summarizer-LICENSE.txt` 和随服务端构建分发的 `server/modules/analysis/pocket48-summarizer.LICENSE.txt`，不变更整个本项目的许可。
- 上游源代码许可不代表视频、人物肖像、字体或云服务授权。归档主 MP4 不接入上游临时音频清理逻辑。实验房间上麦此前按用户要求移除，不因本轮迁移自动恢复。

## 第三批：官方分享链接 → 公开回放 → 去重归档

- 上游 `security.parse_share_url` 只接受 `https://h5.48.cn:443`、无账号信息与片段、路径仅 `/2019appshare/memberLiveShare`、`/index.html`、`/`，`id` 必须为单一 6–30 位 ASCII 数字；上游不回抓分享页或短链。本地 `server/modules/analysis/replay-share.js` 按同一契约实现，并统一规范为 `https://h5.48.cn/2019appshare/memberLiveShare/index.html?id=<id>`。
- 上游 `clients/pocket48.py` 的 resolve_replay 要求 `liveId` 与请求一致、`review:true` 且 `playStreamPath` 非空，再校验媒体/来源主机白名单且不跟随重定向。本地 `replay.js` 的 `normalizeReplay` 保留同等的公开回放门禁，不再只凭媒体地址推断可用。
- 新增 `POST /api/admin/analysis/replay/preview` 与 `POST /api/admin/analysis/replay/import`（必须 `confirmed:true`）：预览 10 分钟有效，只查询、不下载；确认后才经既有完整校验补录链路入队，已有有效归档或进行中的补录直接复用。上游错误仅保留状态码，不回显内部细节。
- 界面入口 `/admin/replay-analysis`（侧边栏"回放分析"，归档页页头亦可达）只让管理员粘贴官方链接，先展示直播 ID/标题/成员/时长，勾选确认后才允许下载；不自动生成字幕、不自动调用付费 AI、不自动投稿。
- 词库身份 `queue.glossaryFingerprint` 只覆盖启用且有效的行并去重排序，停用行与顺序调整不再被视为新词库；翻译任务在作业上记录实际模型与端点，现有 `en` 缓存仍无逐条指纹，重翻前应视为同一提供者产物。

## 第四批：付费边界与来源可核查

- 纠错（`modules/analysis/correction.js` 的 `budgeted`）在每次付费调用前校验单次请求预算：40 条字幕、单条 10,000 字符、词库 20,000 字符、弹幕 1,200,000 字符且不引入时间窗（保持既有行为）；超限直接失败并提示缩小范围，不截断、不猜测。
- 转写断点指纹由 `JSON.stringify(config.glossary)` 改为 `queue.glossaryFingerprint`，与队列侧使用同一稳定身份：停用行、排序变化、离线凭据调整不再触发整场重新转写。
- 纠错完成写入 `correctionEndpoint`，手动编辑字幕时清除 `correctedAt/correctionModel/correctionEndpoint`，避免来源标记与真实内容不符。
- 测试：`server/test/analysis-correction-budget.test.js` 覆盖上限拒绝、实际用量与校验长度一致性。

## 第五批：译文来源、增量翻译与离线热词

- `modules/analysis/translation.js` 为每条译文生成身份：`$v` 版本、`endpoint`、`model`、`instruction`（指令文本哈希），并在字幕行上保存 `enSource`（源文字符串哈希）。`reusable()` 要求三者全部一致；历史裸 `en` 一律视为过期，避免把其他模型或已改写源文的译文当成当前结果。
- 翻译任务改为只请求缺失条目（`missing` 数组仍使用原字幕全局 id），并记录 `translationRequests`/`translationReused`，全命中断点时不发生任何付费调用；写入使用 `stamp()` 生成整行替换，覆盖旧的来源记录。
- 离线 ASR 通过既有 `offline.transcribe(file,model,prompt)` 的 `prompt → initial_prompt` 通道发送热词（`service.js` 的 `hotwords`），仅启用词条、去重、上限 400 字符、剔除控制字符；在线 ASR 接口没有 `prompt` 字段，保持不发送以免被静默丢弃。
- 「启用」判定统一为显式 `true`（`enabled` 缺省也视为启用，字符串 `"true"` 兼容），设置保存、`queue.glossaryFingerprint` 与 `hotwords` 三者一致。
- 测试：`server/test/analysis-translation.test.js`、`server/test/analysis-hotwords.test.js`；分析/回放后端合计 103 项通过。

## 第六批：词库归一与成员身份

- 新增 `modules/analysis/glossary.js`：`fold()`（NFKC、控制字符替换、空白折叠、80 字上限）、`aliases()`（按 `,，、;；|` 切分、去重、外侧空白修剪、160 字上限）、`memberId()`（仅纯数字，兼容 `member.id`/`personId`）、`normalize()`（合并同名词条、合并别名、保留启用状态与成员，返回 `conflicts`）。
- 冲突语义：同一名称出现在两个不同 `memberId` 下才报冲突；未填写成员的词条不视为冲突；内部空格不同的别名不被自动合并，避免把两个人当成一个。
- `settings.save()` 使用 `normalize()` 并写入 `glossaryConflicts`；`AnalysisSettings.jsx` 保存成功后提示需核对的名称与成员。
- 测试：`server/test/analysis-glossary-normalize.test.js` 6 项；分析/回放后端合计 109 项通过；前端全量 88 项中社交账号用例并发超时、单跑通过（既有抖动）。

## 第七批：分析来源清单导出

- `modules/analysis/export.js` 新增 `provenance()` / `renderProvenance()`：阶段清单 `transcribe`（fingerprint + completedAt）、`correct`（model + completedAt）、`translate`（model + translatedSegments）、`summarize`（model + completedAt）。`provider` 字段被有意过滤，服务地址属于基础设施而非结果数据，导出只给模型名；每阶段按可见字段给出 `recorded|partial|absent` 与 `missing` 列表。
- 新端点 `GET /analysis/:id/provenance` 使用与 summary 导出相同的附件、`no-store`、`nosniff` 响应头，并继承管理员鉴权（已加入 `analysis.test.js` 的未认证拒绝清单）。
- 摘要任务写入 `summaryEndpoint` 与 `summarizedAt`；导出快照的 `evidenceIds` 恢复时间重叠过滤（`segments[id].start < end && segments[id].end > start`），杜绝越界/伪造引用。
- 测试：`server/test/analysis-provenance.test.js` 3 项；分析/回放后端合计 112 项通过。

## 第八批：来源清单界面

- `components/AnalysisProvenance.jsx` + `.css`：可折叠区块，挂载于 `RecordingDetail` 分析面板之前；阶段顺序固定为语音识别 / 纠错 / 英文翻译 / 总结，状态用 `recorded|partial|absent` 映射为「已记录 / 信息不全 / 缺少记录」。
- 数据只在首次展开时请求；失败态显示服务端错误并允许重试，不会用空表掩盖失败；再次展开复用缓存数据。
- 指纹展示：`stage.fingerprint` 存在而模型缺失时显示「未记录模型（指纹 …）」前 12 位，说明记录存在但模型名没有落盘。
- 测试：`client/test/analysis-provenance-ui.test.js` 2 项（Playwright + 无 socket Vite 夹具）。

## 第九批：清空分析重来

- `service.clearAnalysis(id)`：`ensureOwner` 后校验归档存在、无派生任务（`pending` 合并本进程 jobs 与 `store.load('analysis_jobs')`）、存在可清空内容，再写 `_before_clear` 快照并落盘空结果，字段清理与恢复原文保持一致（summary/summaryModel/summaryEndpoint/summarizedAt/correctedAt/correctionModel/correctionEndpoint）。
- 路由 `DELETE /analysis/:id` 强制 `confirmed===true`，继承管理员鉴权（已加入未认证 401 断言）。
- 前端 `AnalysisPanel` 增加 `clearAll()`：`window.confirm` → `adminApi.delete(`/analysis/:id`,{data:{confirmed:true}})` → 重置标签、语言与搜索；任务进行中或没有字幕时不显示。
- 测试：`server/test/analysis-clear.test.js` 2 项；`client/test/analysis-clear-ui.test.js` 2 项（取消确认不调用接口、确认后携带 confirmed=true、空归档无按钮）。

## 第十批：离线模型档位与公开回放字段收敛

- 离线 ASR：`offline.py` 模型白名单与 `revisions` 增加 `small`（`536b0662742cf9da4f2d0b7380c4c62bb7015b8c`），`offline.js` catalog 与 `settings.save()` 同步为 tiny/base/small；测试 `offline.test.js` 新增档位用例，确认非法档位在 spawn 之前被拒、`small` 未安装时提示安装而不是报无效。
- 公开回放：`modules/pocket48/replay.js` 拆出 `publicReplay()` 白名单（liveId/title/cover/startedAt/duration/durationSeconds/liveType/liveMode/status/member/team），`getReplay()` 返回白名单；`review`、`streamPath` 保留在 `normalizeReplay()` 供导入门禁使用。旧断言「公开 DTO 含 review」是未迁移的安全回归，已由 `test/replay-public-dto.test.js` 替代。

## 第十一批：队列健康统计

- `analysis/queue.js` 新增纯函数 `health(jobs,config,now)`：完成/失败/执行中/等待计数、`blockedByDisallowedPolicy`（`allowed()` 判定为假且仍排队）、`dormantRetries` 与 `nextWakeAt`、`recoveredLastStart`/`interruptedLastStart`。输入损坏时降级为 0，不抛出。
- `service.queueStatus()` 附带 `health`；`AnalysisSettings.jsx` 用 `role=list` 区块展示，正常队列只显示一行计数，异常才追加说明；无 `health` 字段时不渲染。
- 测试：`server/test/analysis-queue-health.test.js` 3 项、`client/test/analysis-health-ui.test.js` 3 项；`analysis-queue-status.test.js` 与 `analysis-queue-process.test.js` 的字段白名单断言加入 `health`，并验证 health 自身也是固定白名单、不含队列内容。
- `client/test/social-browser.test.js` 的 `goto`/`reload` 统一放宽为 60 秒并等待 `domcontentloaded`：原先 6 秒默认超时在并发冷启动 Vite 变换时超时，属于夹具抖动而非功能回归；元素级断言超时保持 6 秒不变。

## 第十二批：来源清单标注服务

- `export.js` 的 `hostOf()` 只从端点取出 host，`stage()` 把 `provider` 从「不可见字段」改为「脱敏可见字段」，因此仍是 `missing` 的一项但不会泄露 URL。
- 测试：`analysis-provenance.test.js` 4 项（新增带 query 与非法端点的用例）；`analysis-provenance-ui.test.js` 2 项新增服务列与缺省「—」断言。

## 第十三批：整批来源清单

- `export.js` 新增 `batchProvenance(records, now)`：空列表/超过 50 条直接 400，重复 id 去重，非对象或缺 id 的输入产出错误行而非静默丢弃；输出仍是每条的 `provenance()` 值，因此脱敏规则天然共用。
- 路由 `POST /analysis/provenance/batch` 放在 `POST /replay/import` 之后、`/:id` 之前，避免被 `:id` 吞掉；沿用 `no-store`/`nosniff` 附件响应头。
- 前端 `components/AnalysisProvenanceBatch.jsx` 供整批核查使用，测试 `client/test/analysis-provenance-batch-ui.test.js` 2 项。

## 第十四批：可读版来源清单

- `export.js` 新增 `renderProvenanceText()`：与 JSON 同源（同一 `provenance()`，服务仅主机），缺失字段写「缺少记录/缺失」而不是留白；指纹无模型时标注「未记录模型（指纹 …）」。单元格经既有 `escape()` 转义，管道与反斜杠不会破坏表格。
- `GET /analysis/:id/provenance` 增加 `format=json|markdown`，默认 json 保持兼容；非法格式 400。
- 测试：`server/test/analysis-provenance-markdown.test.js` 3 项；界面用例新增 Markdown 下载链接断言。

## 第十五批：来源清单表格导出

- `export.js` 新增 `csvProvenance(entries)` 与 `CSV_COLUMNS`；`csvCell()` 先用 `String()` 之外的数值分支保留 0，再按公式前缀与 RFC 4180 规则转义。
- 路由 `POST /analysis/provenance/batch` 增加 `format=json|csv`：CSV 分支按 id 补齐标题（`manager.getRecordings()`），逐条尝试 `service.result()`，失败标为「未分析」而不中断整批。
- 测试：`server/test/analysis-provenance-csv.test.js` 3 项（行结构、注入与换行防护、无 URL/密钥）；`analysis-provenance-batch-ui.test.js` 增加 CSV 按钮断言。

## 第十六批：日文翻译目标

- `translation.js`：`TARGETS`（en/ja 各自版本与指令）、`column()`（en / enJA）、`targetOf()`（非法值回落），`identity/reusable/stamp` 全部按目标语言取列与比对；缺 `target` 的历史记录按英文处理，避免既有译文全部失效。
- `service.enqueue(id,kind,{target})` 把目标写在作业上，翻译分支用对应指令与身份，并记录 `translationTarget`；路由传递 body.target。
- 已知限制（已写入测试）：一行只有一份 `translation` 来源记录，日文翻译后英文文本仍在但需重新盖章才算「当前」；不谎称双语可同时续传。
- 测试：`server/test/analysis-translation-target.test.js` 3 项；分析/回放后端合计 132 项通过。

## 第十七批：日文字幕轨与编辑失效

- `subtitle()` 支持 `ja` / `ja-bilingual`；双语第二行只在确有译文时输出，绝不产生空行。第一版实现曾让「存在日文列」改变既有 `bilingual` 输出，导致同行断言与 srt 用例失败，已改为显式模式分流。
- `editSegment()` 同时清空 `enJA`；测试 `server/test/analysis-subtitle-ja.test.js` 2 项覆盖列选择、回落、双语与编辑失效。
- 前端 `AnalysisPanel` 增加日文/中日双语选项、VTT 轨道标签与 srclang、同步字幕与搜索字段。
- 分析/回放后端合计 134 项通过；分析面板浏览器用例 4/4。

## 第十八批：双语导出

- `snapshot()` 用 `row()` 构造字幕行：`ja` 只在 `enJA` 非空白时加入，因此 `Object.keys` 白名单在旧归档上保持不变；来源与检查点仍被过滤。
- `render()` 的 Markdown 证据段追加英/日译文行（有则显示，无则省略）。
- 测试：`server/test/analysis-export-ja.test.js` 3 项；分析/回放后端合计 137 项通过。

## 第十九批：证据译文对照

- `AnalysisPanel` 的字幕证据项追加 `英文：` / `日文：` 两行（仅当字段存在），并新增 `.analysis-evidence-translation` 样式。
- 测试：`client/test/analysis-evidence-translation-ui.test.js`（有日文与无日文两种行）；分析面板既有 4 项用例保持通过，合计 5/5。

## 第二十批：日文来源核查

- `provenance()` 用 `isEn()` 判定英文行（要求 `target` 为 en 或缺失），避免日文盖章行被算成英文；新增 `translate-ja` 阶段与 `japanese` 汇总块（无日文时为 null）。
- `renderProvenanceText()` 增加日文标签与统计行。
- 测试：`server/test/analysis-provenance-ja.test.js` 3 项；`analysis-provenance-markdown.test.js` 阶段数由 4 改为 5；来源清单全部用例 19/19，分析/回放后端 140/140。

## 第二十五批：公开回放总结

- `routes/public.js` 新增 `/replays/:liveId/summary`：按 `liveId` 找到 `status=done`、`source=pocket48`、非音频、非剪辑段的归档，再读分析结果；仅当 `summary` 非空才输出白名单 DTO（recordingId/summary/chapters/highlights，start/end/title/summary）。`Cache-Control: public, max-age=60`。
- 404 统一为「Replay summary is unavailable」，不区分「没有归档」「没有总结」「分析读取失败」，避免泄露管理员进度。
- `PublicReplay.jsx` 增加 `PublicReplaySummary` 卡片，只在取到总结时渲染；测试 `server/test/replay-public-summary.test.js` 3 项、`client/test/public-replay-summary-ui.test.js` 2 项。
- 这是差距表中「公开分析」的第一半（只读公开总结）。「邀请账号」与界面多语言仍未实现。

## 第二十六批：公开总结开关

- `analysis/settings.js` 新增 `publish` 三项开关，`get()` 负责与默认值合并，`save()` 严格校验类型与键名；`public.js` 在读取分析前先判断 `publish.summary`。
- 设置页「公开回放总结」卡片与开关 UI；章节/精彩片段随总开关禁用。
- 测试：`server/test/analysis-publish-settings.test.js` 3 项、`replay-public-summary.test.js` 增至 5 项、`client/test/analysis-publish-ui.test.js` 1 项。排查中确认 `node:test` 会并发启动同一文件的用例，共享设置必须由用例自身在 finally 恢复，afterEach 会在别的用例运行中途改配置。

## 第二十七批：公开详略两档

- `settings.js` 新增 `publicDetail.mode`（full/chapters），`get()` 校验并把非法值回落为 full；`public.js` 在 `chapters` 模式下清空 `summary` 并标注 `detail`。
- `PublicReplay.jsx` 修复「正文为空即不渲染」的缺陷，改为正文或章节/高光任一存在就渲染，并给出去正文提示。
- 测试：`analysis-publish-settings.test.js` 增至 4 项、`replay-public-summary.test.js` 增至 6 项、`public-replay-summary-ui.test.js` 增至 3 项。后端全量 349（348 通过/1 跳过）、前端 98 全通过。
- 说明：本轮曾尝试用子代理（`upstream-audit`、`insights-core`）并行核对上游公开分析与邀请账号，但成员未能返回结论（无收尾消息），因此本节不含任何来自第三方的结论。

## 第二十八批：成员资料邀请访问码

- `modules/social/access.js`：`create/list/revoke/resolve/publicAccounts`；`create` 校验有效期（1–720 小时且 ≤30 天）并替换同名成员的旧码；`resolve` 用定长字符串校验挡住路径穿越与超长输入。
- `routes/social.js` 增加三条管理员接口；`routes/public.js` 增加 `/social/:code`，字段白名单由 `publicAccounts()` 决定。
- 测试：`server/test/social-access-codes.test.js` 5 项（明文不落盘、过期与撤销、替换语义、字段白名单、路由 404 与 no-store）。后端全量 354（353 通过 / 1 跳过）。
- 差距表「邀请账号」从「未做」推进到「只读分享已做；账号体系与界面多语言仍未做」。

## 第二十九批：分享面板

- `SocialAccounts.jsx` 增加分享面板（成员选择、有效期、生成、复制、撤销）与 `loadCodes/createCode/revokeCode`；样式在 `SocialAccounts.css`。
- 明文访问码只存在于组件状态，不会回写服务端，也不会出现在列表里。
- 测试：`client/test/social-access-ui.test.js` 1 项（列表含有效与过期、POST 体为 `{memberName,hours}`、新链接只出现一次）。前端全量 99。

## 第三十批：访客可读页

- `pages/PublicSocial.jsx` + 路由 `/s/:code`（懒加载，与其它公开页并列）；`App.css` 增加对应样式。
- `SocialAccounts.jsx` 的 `shareUrl()` 由 `/api/public/social/…` 改为 `/s/…`。
- 测试：`client/test/public-social-ui.test.js` 2 项（有效码渲染成员与主页链接、失效码中性提示且无成员名）。前端全量 101 全通过，后端 354（353 通过 / 1 跳过）。
- 排查记录：第一版夹具把页面直接挂在 MemoryRouter 下，`useParams()` 取不到 `code`，请求退化成 `/api/public/social/`。真实应用在 `<Route path="/s/:code">` 中渲染，夹具改为同样的结构后通过——这不是产品缺陷。

## 第三十一批：分享预览卡片

- `modules/analysis/share-preview.js`：`tagsFor(pathname, lookup)`、`inject(html, tags)`、`escape`、`text`。
- `routes/public.js` 抽出 `publishedSummaryFor(liveId)` 并挂到 router 上，JSON 接口与分享卡片共用同一判断。
- `index.js` 的 SPA 回退改为按路径判断：命中已发布回放则读取 `index.html` 注入标签并设 `Cache-Control: public, max-age=60`，否则保持原来的 `sendFile`。
- 测试：`server/test/share-preview.test.js` 4 项（只对已发布注入、转义与截断、替换标题、HTTP 层实测）。后端全量 358（357 通过 / 1 跳过）。

## 第三十二批：访问码使用审计

- `social/access.js`：`resolve()` 命中后累加 `uses` 并写 `lastUsedAt`（try/catch 包裹，失败不影响访问）；`list()` 输出这两项但依旧不暴露 `hash`。
- `SocialAccounts.jsx` 的分享列表显示访问次数与最近时间。
- 测试：`social-access-codes.test.js` 增至 6 项（成功才计数、错误码不计、无 IP/UA 落盘、列表无 hash）；`social-access-ui.test.js` 增加「已访问 3 次」断言。后端 359（358 通过 / 1 跳过），前端 101 全通过。

## 第三十三批：复制回放链接

- `PublicReplay.jsx` 增加 `shareState` 与 `copyShareLink()`，在总结位置上方渲染分享按钮；`App.css` 补 `.public-replay-share`。
- 测试：`public-replay-summary-ui.test.js` 增加「分享按钮只渲染一次」断言，防止分支重复渲染。
- **过程如实记录**：本轮对该文件的多次字符串替换叠加出错，一度写坏了组件结构（重复声明、导入块落进组件体、多余右括号），构建连续失败。最终按括号深度分析、用已保存的原始片段分块重建，并用「检查所有大写 JSX 标识符是否已导入」的脚本一次性补齐 `IconTv/IconSearch/EmptyState` 等被删掉的导入。恢复后用前端全量 101/101 与构建 exit 0 验证。教训：对超长文件的局部改写应先备份并做导入完整性检查，而不是连续多次替换。

## 第三十五批：公开范围只读摘要

- `AnalysisSettings.jsx` 在公开总结卡片内渲染 `.analysis-publish-summary`，由 `publish.*` 与 `publicDetail.mode` 派生文案；样式在 `AnalysisPanel.css`。
- 测试：`analysis-publish-ui.test.js` 增加两处断言（默认「不公开」、开启后「完整总结正文 · 含章节 · 含精彩片段」）。

## 第三十六批：分享页中英文

- `PublicSocial.jsx` 抽出 `TEXT.zh` / `TEXT.en` 与 `languageOf()`，组件按浏览器语言取文案；群类型标签按语言映射（`other:` 前缀的群名沿用管理员填写内容）。
- 测试：`public-social-ui.test.js` 新增英文浏览器用例（英文失效提示、不含中文文案）。前端全量 102，后端 359（358 通过 / 1 跳过）。
- 差距表「界面中英」从「未做」推进为「公开分享页已双语；其余页面仍为中文」。

## 第三十七批：回放页文案表（第一步）

- `PublicReplay.jsx`：新增文案表与 `languageOf`；`REPLAY_TYPES` 常量并入 `text.types`；分享按钮与总结卡片文案改为按语言取。
- 并行：成员 `share-intake-ui` 在 `PublicSocial.jsx` 补 `export const SOCIAL_TEXT = TEXT;`（供测试/复用），自带构建验证 BUILD=0；`i18n-inventory` 成员做管理端文案只读盘点。
- 验证：构建 exit 0，`public-replay-summary-ui` 3/3、`public-social-ui` 3/3。

## 第三十九批：公开直播页与 LoadingState 双语

- `PublicLive.jsx`：新增 `TEXT`/`languageOf`，28 条文案改引用；注意批量替换时 JSX 属性必须写成 `{t.x}`，本轮首次替换漏了花括号导致构建报错，已用正则统一修正。
- `LoadingState.jsx`：导出 `LOADING_TEXT`、`languageOf`，新增可选 `languages`；默认行为不变。
- `loading-state-slow.test.js`：两处源码字面量断言改为「文案表键 + 接线 + 参数」断言，原覆盖点（慢状态存在、参数 5000、重试回调、定时器清理）全部保留。
- 验证：前端全量 104/104，构建 exit 0。

## 第四十批：回放页文案补全（含事故记录）

- `PublicReplay.jsx` 文案表补齐 `page`/`detail`/`download`/`service`/`words` 五组，共 40 余条；辅助函数 `normalizeReplay`/`formatReplayTime`/`downloadLabel`/`downloadNote` 增加 `t` 参数并给中文默认值，页面内一律显式传入。
- **事故记录（必须记住）**：本轮我用「先替换标识符、再补花括号」的方式批量改 JSX，导致 `text=t.x` 语法错误；随后用字符串切片重建文案表时，`String.replace` 的回调参数写错（把函数当成替换文本），把表格里 31 处中文替换成了 `t.page.xxx`，进而整块表被写坏，最严重时文件只剩 89 行（组件主体被截断）。恢复手段是从本轮开始前保存的快照取回组件主体，并**用字面量重新写一遍文案表**（不对文件做任何替换）。
- 教训：①文案表这类结构化数据应当整块直写，绝不能对着旧文件做连锁替换；②每次改动后既要用 `grep` 确认关键行，也要用「计数断言」（如 `zh:`/`en:` 各出现一次）自检；③JSX 属性必须一次写全 `={}`。
- 验证：前端全量 104/104（并发 2），`public-replay-summary-ui` 3/3、`loading-state-slow` 6/6，构建 exit 0。

## 第四十一批：热词准入（对齐上游 vocabulary.py）

- 上游证据：`src/pocket48_summarizer/vocabulary.py` 的 `_valid_hotword`（NFKC 归一化 + `strip_control_chars`、非 ASCII 限 15 字、ASCII 限 7 段）与 `_build_vocabulary`（`normalize_glossary_text` 去重、权重与上限）。本轮按固定提交 `d5f45a…` 的源码逐条移植为 `app/server/modules/analysis/hotwords.js`。
- 差异说明：上游把词表编译成 DashScope 预编译热词列表并轮询就绪；本地没有该凭据与费用授权，因此只移植**准入与去重规则**，仍通过离线 ASR 的 `initial_prompt` 传递，不新增任何外部调用。
- `service.js` 的 `hotwords()` 改为调用同一模块，行为变化：全角/半角与大小写重复词条被合并，超长词条被剔除，预算裁剪不再切断代理对。
- 测试：`test/analysis-hotwords.test.js` 5 条；后端全量 361 项 / 360 通过 / 1 跳过。

## 第四十二批：成员回放自动巡检（功能块 A）

- 上游证据：`src/pocket48_summarizer/replay_watch.py`（固定提交 `d5f45a…`）——单成员、`enabled_at_ms` 窗口、`last_attempt_at_ms` 24 小时节流、成员不匹配即报错、失败记录 `last_error_code`。
- 本地实现：`modules/pocket48/replay-watch.js`（`configure`/`status`/`tick`/`select`/`start`/`stop`），状态落盘 `replay-watch.json`；启动与停止挂在 `server/index.js`，与自动签到一起。
- 差异：上游直接 `create_or_get_job` 建任务；本地复用 `analysis/replay-intake.preview/confirm`，因此同一场回放无论来自粘贴链接还是巡检，都走同一条校验与去重路径。
- 去重依赖只读视图：`replay-intake._internals.archivedLiveIds()/activeLiveIds()` 与 `replay-import.activeLiveIds()`，均不改变既有行为。
- 测试：`test/replay-watch.test.js` 5 条（窗口/成员/已归档/下载中/重复、参数校验、尝试时间戳防抖）；后端全量 366 项 / 365 通过 / 1 跳过。
- 前端：口袋48账号面板新增巡检设置块与「立即检查一次」，测试 `replay-watch-ui.test.js`；前端全量 105/105。

## 第四十三批：回放导入幂等与预览边界（功能块 B）

- 上游证据：`repository.py` 的 `create_or_get_job`——同一 live id 再次提交返回既有任务，而不是新建；`security.parse_share_url` 只接受固定 h5.48.cn 分享形态（批次三十已移植）。
- 本地改动：`replay-import.enqueue()` 默认幂等——命中未结束任务时直接返回该任务；`idempotent: false` 保留旧行为。为什么不是无条件幂等：手动重试按钮依赖 409 展示「已在导入中」的提示，直接改成幂等会让用户以为又提交了一次。
- `confirm()` 现在与 `enqueue()` 共用这一路径，因此双重点击预览确认、或巡检与手工粘贴同时发生，都只会产生一个下载任务。
- 路由：`POST /replay/import` 新增 `source` 入口（服务端内部先 `preview` 再 `confirm`），`confirmed: true` 的门槛未改动；新增 `GET /replay/import/:id`。
- 测试：`test/replay-import-idempotent.test.js` 3 条；后端全量 369 项 / 368 通过 / 1 跳过。

## 第四十四批：LRC 与识别结果解析（功能块 C）

- 上游证据：`src/pocket48_summarizer/parsing/lrc.py`（`LRC_LINE_RE`、`DANMAKU_SYNC_ADVANCE_MS=3000`、`parse_lrc_timestamp`）与 `parsing/transcript.py`（`normalize_asr_result`、`transcript_to_srt`、`format_srt_time`）。
- 本地实现：`modules/analysis/parsing.js`，导出 `parseLrc`/`toLrc`/`parseLrcTimestamp`/`normalizeAsrResult`/`transcriptToSrt`/`formatSrtTime`；`service.normalizeSegments` 在收到 `transcripts` 形态时改走该模块。
- 差异：上游只解析不生成，本地额外提供 `toLrc`（导出弹幕为 LRC），因此格式必须与解析互逆——本批为此修了一处自成闭环的缺陷（`toLrc` 少写方括号）。
- 事故记录（必须记住）：本条目的调试耗时约 40 分钟，原因是我反复用「字符串替换 + 小脚本验证」的方式修改同一个函数，`trim()` 与切片索引相互干扰，且控制字符正则把制表符一起删掉，导致相同输入的解析结果在不同调用路径下不一致。**教训**：涉及不可见字符的解析代码，必须一次性整段落笔，并用「输入码点 — 中间值 — 输出码点」三段对照验证，不要在一个函数上连续做替换实验。
- 测试：`test/analysis-parsing.test.js` 7 条；后端全量 376 项 / 375 通过 / 1 跳过。

## 第四十五批：OSS 适配器（功能块 D，仅配置与签名）

- 上游证据：`clients/oss_store.py`——`OssStore.__init__` 的四项配置完整性检查、`object_key`/`clip_object_key` 前缀布局、`sign_url(slash_safe=True)` 的 V1 签名。
- 本地实现：`modules/analysis/oss-adapter.js`（`inspect`/`objectKey`/`sign`/`signedUrl`）。
- **明确未做**：`upload`/`delete`/`download` 与 AI 封面对象操作。理由：需要真实 AK/SK 与真实 OSS 请求，而本工作区约定不发起外部付费或凭据调用。这部分留作后续人类授权后的单独验收项，不宣称已迁移。
- 与 DashScope 预编译热词的取舍一致：只迁移可离线验证的规则层（批次四十一的热词准入）。
- 测试：`test/oss-adapter.test.js` 6 条；后端全量 382 项 / 381 通过 / 1 跳过。

## 第四十六批：并行迁移七项（OSS / DashScope / 异步 ASR / AI 扩图 / 横屏 / 多版本导出）

本批由主会话分派 8 个队友并行完成，主会话只做分派、审核与合并。每项的实现位置、证据与「没做到什么」如下——**边界是本批最重要的交付内容**。

| 能力 | 实现位置 | 上游证据 | 层级 | 测试 | 明确未做 |
| --- | --- | --- | --- | --- | --- |
| OSS 上传/删除 | `server/modules/analysis/oss-adapter.js`、`oss-sync.js` | `clients/oss_store.py` | 模块层真实现（流式 PUT/DELETE/HEAD） | 23 项 | HTTP 上传/删除入口、自动钩子、分片续传、转码；未真实云端验证 |
| DashScope 预编译热词 | `server/modules/analysis/dashscope-vocabulary.js` | `clients/dashscope.py`、`vocabulary.py` | 本地 CRUD + 内容哈希 + 原子写入 | 与下条合计 13 项 | 不创建云端词库 ID，不发请求 |
| 异步 ASR 任务 | `server/modules/analysis/dashscope-asr.js` | `clients/dashscope.py` | 本地状态机，默认 skipped | 同上 | 未接既有同步 ASR、无自动轮询、不下载结果；cancel 不停止云端计费 |
| AI 扩图封面 | `server/modules/analysis/ai-cover.js` | `clients/seedream.py`、`media/ai_covers.py` | 请求体构造 + 本地规划规则 | 13 项 | 不接真实 AI、不上传、不做视觉评分；几何与评分为本地策略 |
| 导出档位 | `server/modules/analysis/export-profiles.js` | `media/layouts.py` | 仅参数层 + 响应头 | 5 项 | 未接 FFmpeg、不转码；码率为本地建议值 |
| 回放页横屏版式 | `client/src/pages/PublicReplay.jsx`、`PublicReplay.css`、`hooks/useReplayLayout.js` | `media/layouts.py`（版式思路） | 前端真接通 | 3 + 6 项 | 上游 6 种配色、字幕叠层渲染未迁移 |
| 多版本导出 | 回放页选择器 + 归档详情导出面板 | — | 仅 UI / 参数层 | 3 + 2 项 | 三个导出选项禁用，公开接口只有原始 MP4，不生成转码文件 |

### 审核要点（本批踩过的坑，必须记住）

- **假红三次**：缺 `FFMPEG_BIN`/`FFPROBE_BIN`/`COVER_PYTHON_BIN` 两次、并行跑 Playwright+Vite 抢 24678 端口一次。全量必须注入三变量且串行/单会话运行。
- **上游没有的规则不能冒称上游**：AI 扩图的比例夹取、候选挑选、重试上限均非 `seedream.py`/`ai_covers.py` 内容，代码头注释与 CHANGELOG 均标「本地策略，非上游规则」，测试名用 `upstream:` / `local-rule:` 分组。
- **共享文件冲突**：`routes/analysis.js` 被三方同时修改，出现过 `FS_STALE_VERSION`。纪律是「重读 → 定点插入 → 复核他人内容仍在」，合并后由主会话逐行核。
- **样式只数名字会判错**：判断样式冲突必须看 DOM 层级，不能只看 class 名是否存在；错误裁决已由 `analysis-ui` 用证据纠正。
- **OSS Endpoint 正则曾过宽**：`xxxattackeraliyuncs.com` 这类拼接域在只做配置判定时无害，加上真实传输层后就变成凭据外泄风险。已收紧为完整标签边界并补拒绝用例。

### 验收记录

- 后端全量：430 项 / 429 通过 / 0 失败 / 1 跳过（exit 0）。382 基线 +48 项可逐项归因（导出档位 5、AI 扩图 13、OSS 17、DashScope 13）。
- 前端全量：121 / 121 通过（exit 0）。110 基线 +11 项（回放版式 3、hook 6、导出面板 2）。
- 前端构建 exit 0（151 modules）；`node scripts/version.mjs check` → PASS 1.27.8。
- 全程未调用真实 Pocket48 / OSS / AI 接口，未读取或写入任何凭据，未部署生产。

## 功能差距与顺序

| 能力 | 本地基线 | 本轮/后续 |
| --- | --- | --- |
| 回放导入、直播录制与官方回放修复 | 已有 | 复用；不替换录制主链路 |
| 在线/离线 ASR、SRT 导入与人工纠错 | 已有 | 复用；本轮不改变 ASR |
| 时间/字符双限摘要分块 | 原按 100 条字幕 | 本轮实现 360 秒 / 12000 字符双限；单条超限明确拒绝 |
| 字幕证据约束章节/高光 | 原仅范围校验 | 本轮实现 0-based evidenceIds 与时间相交校验；并非语义真实性保证 |
| 摘要覆盖/长静默 | 原无覆盖报告 | 本轮添加字幕时间窗覆盖校验，静默单独报告；不足时仅可用有证据候选补齐，否则失败 |
| 摘要分块断点续传 | 原整场重做 | 本轮实现独立 checkpoint，按字幕/时间/模型/端点/协议版本指纹失效 |
| Markdown 总结与结构化 JSON 下载 | 原只有 SRT | 本轮新增管理员附件导出，白名单字段，不导出设置/密钥/任务内部状态 |
| 字幕证据展开与跳转 | 原无 | 本轮新增，兼容旧无证据结果 |
| 英文/日文翻译与双语播放 | 已有翻译及续传 | 已修正原生字幕轨双语显示；已支持日文目标语言、日文字幕轨与中日双语、日文来源核查；独立自动翻译队列仍待评估 |
| 耐久任务租约与退避重试 | 原内存队列 + 重启失败标记 | 第二轮已实现：queued 保留、显式中断恢复、队列级可选 5/15/60 分钟退避、预算/取消/新任务优先，本地单主机同 PID 命名空间 owner 围栏；不宣称分布式或容器异常恢复 |
| 直接分享链接处理与轻量音频管线 | 已有官方回放导入但非同等工作流 | 已做：成员回放自动巡检（批次四十二），复用固定 h5.48.cn 链接解析 + 预览确认 + 导入去重；任意 URL 代理仍不做 |
| DashScope 异步 ASR / 私有 OSS / 热词版本 | 现有 OpenAI-compatible ASR 与本地离线识别 | 已做：热词准入规则（四十一）、OSS 配置与签名（四十五）。仍缺：OSS 上传/删除、DashScope 预编译热词客户端、异步 ASR 任务，均需凭据与费用授权 |
| 成员词库别名冲突与热词指纹 | 已有普通纠错词库与成员目录 | 已移植上游热词准入规则（NFKC/长度/去重）；别名唯一性与词库版本指纹仍未做 |
| AI 精细时间线、静音吸附、人工剪辑 | 已有可缩放时间线及多段剪辑 | 后续：精细上下文/静音吸附与字幕弹幕烧录差距核对 |
| 横屏主题、emoji 合成、多版本导出 | 已有基本剪辑/封面与B站草稿 | 已做：回放页横竖版式（第四十六批）；仍缺：emoji 合成、真实转码导出（导出档位目前仅参数层） |
| Seedream AI 扩图封面 | 已有截图/成员模板，无同等付费生成 | 已做：请求体构造与本地规划规则（第四十六批）；仍缺：真实调用需显式费用确认与独立开关 |
| 公开分析、邀请账号与界面中英 | 公开回放总结可开关公开；社交资料可生成限时访问码；访客资料页已中英双语，其余界面仍为中文 | 第七～十三批已补齐分析来源清单（单人/整批 JSON/Markdown/CSV，仅主机名）与队列健康统计；第十六～二十一批补齐日文翻译目标、日文字幕轨与中日双语、双语导出、证据译文对照与日文来源核查；「邀请账号」与界面多语言仍未做，需先明确公开范围与权限 |
| 房间上麦实验监控 | 已按此前需求移除入口/停监控 | 不自动恢复；需独立重新授权与隐私评估 |

## 本轮接口与兼容性

- 管理员 `GET /api/admin/analysis/:id/summary?format=markdown|json`，默认 Markdown；缺总结 409，非法格式 400，缺归档 404；沿用管理员认证，附件响应禁止缓存。
- JSON schemaVersion=1，字段仅 recordingId、summary、chapters、highlights、segments；证据 id 对应 segments 的 0-based 序号。Markdown 中以从 1 开始的字幕序号显示。
- 历史结果未提供证据时明确标注，不编造引用。新摘要必须通过证据和窗口检查；任何校验不等于模型理解准确。
- 手动重试可复用已完成摘要块；新结果全部成功前保留旧成功结果。第二轮新增队列级自动重试与中断恢复，但默认均关闭，必须由管理员显式保存配置后开启；可能重复计费。
- 仅使用离线合成字幕/模拟模型回归，不默认调用真实 Pocket48、ASR、LLM、OSS 或 Seedream。

## 上游实现证据

以下路径均相对固定提交的 `src/pocket48_summarizer/`：

- `summarization/service.py:73-139` 分块与缓存指纹，`:455-617` 引用校验与遗漏覆盖修复；`summarization/prompts.py:11-14` 不可信字幕边界。
- `pipeline.py:95-206` HLS/OSS/DashScope 与临时对象清理；`repository.py:3209-3274` 事务领取与退避重试；`worker.py:461-477` 租约心跳。
- `translation.py:46-88` 翻译分批；`media/clips.py:159-290` 独立导出版本；`security.py:24-85` 固定主机与输入校验。
- 上游仅做源码审阅，未运行其 Python 全量测试；不能将上游已有实现等同于本地迁移完成。

## 验证记录

2026-10-22 首轮本地验证（不是生产发布验收）：

- 版本检查：`node scripts/version.mjs check` 通过，仍为 1.27.6。
- 相关后端回归：`node --test test/analysis*.test.js test/correction.test.js test/srt.test.js test/text-probe.test.js`，30/30 通过；其中新增证据/续传纯逻辑与队列集成 12 项、总结导出 6 项。
- 新增分析面板浏览器用例：4/4 通过，覆盖证据/XSS纯文本/原片跳转、历史结果/导出状态、双语 WebVTT 与归档切换迟到响应。主理人修复测试 Vite 缓存和 HMR 端口隔离后复验通过。
- 前端生产构建：bundled Node + pnpm `--config.verify-deps-before-run=false run build` 通过（144 模块），仅现有 chunk 体积警告。默认 pnpm 预检被既有 esbuild allowBuilds 占位配置阻断；没有改动依赖或审批配置。
- 后端全量首次：240 项，237 通过 / 2 失败 / 1 跳过。封面测试默认 `/opt/asr-venv/bin/python` 不存在；改用当前已有 `.tools/cover-venv/Scripts/python.exe` 后独立复验 1/1 通过。另一失败为 Windows 将文件 mode 报告为 0666，而测试硬断言 Unix 0600；未修改会话安全代码或放宽断言，不将其记为通过。
- 前端全量：首次未设置 CHROMIUM_PATH 的旧测试在 Linux 默认浏览器路径失败且未清理服务，已终止并收集该运行；随后配置本机 Chrome 重跑；新增用例的并行 Vite 共享缓存/HMR 干扰由主理人隔离修复。最终 83 项，81 通过 / 2 失败；剩余失败为未改动的封面 UI 等待「图片居中 · 背景虚化」超时、口袋登录 UI 等待「测试凭据无效」超时。新增 4 项在最终全量中均通过；尚未定位剩余 UI 失败根因，不将全量记为通过。
- 所有测试用合成归档/模拟 API；未调用真实收费模型、未部署、未触碰运行账号与凭据。

## 第二轮：耐久队列、回归闭环与边界

- `analysis/queue.js` 管理可注入时钟的恢复/公平调度/预算和固定退避。普通 queued 任务重启保留；running 默认失败并保留断点，仅 resumeInterrupted 显式开启时消耗重试预算重新排队。首次任务优先于延迟重试；所有 pending/running 永久保留在任务账本，300 条限制只作用于 terminal 历史。
- `queue.autoRetry` 仅控制整任务级自动重试（默认 false），最多 0–3 次，5/15/60 分钟，Retry-After 最长 24 小时；现有 ASR 分段短退避/524 拆分保持原行为，不能将其误称为本开关控制。端点/模型变化、关开关、取消、主动 stop、认证/输入/schema/磁盘错误会阻止不合规重试。
- `analysis/queue-lease.js` 在同主机本地盘同 PID 命名空间用 owner token/PID 存活/心跳保护单实例；活 owner 不抢占，死 PID 可回收。不同 hostname/namespace、不完整 owner 或回收门闩保守拒绝，不盲删。此阶段不支持分布式/容器重建或异常退出后的跨命名空间自动恢复。
- start 的锁/损坏数据异常只让分析 unavailable，不影响 HTTP 与录制启动；queueStatus/result 的只读列表对非数组和坏行安全降级，错误状态不覆写原队列文件。主动 stop 等待在途操作再释放所有权；失锁取消并阻止旧 worker 写入。
- 管理员 `GET /api/admin/analysis/queue` 仅返回安全字段 state/owned/queued/running/error/localOnly，不暴露 owner token、PID、主机、路径或凭据。设置页展示可用状态与限制，归档面板显示北京时间的计划重试、次数和取消入口。
- 修复口袋凭据 401 被误判本站管理员失效的真实 bug。三个受保护 POST 登录端点在外部拒绝时返回 errorCode=POCKET48_LOGIN_REJECTED；拦截器仅对精确端点/POST/marker 豁免跳转，其他 401 仍要求本站重登。封面旧测试改验现行选择器/上传和退役入口重定向，不恢复已退役功能。

### 第二轮验证

- 最终相关后端：72/72 通过，含队列纯策略/时钟、真实子进程锁竞争与死亡恢复、进程断电后 queued/running 与摘要 checkpoint 恢复、取消/预算/配置变化/磁盘回滚、坏 JSON 形状非致命降级、状态权限与登录标记。最终 compact/只读形状修改均纳入本次复验。
- 最终前端全量：86/86 通过；此前未过的封面和口袋登录 UI 都已闭环。新增队列 UI 用例关闭 harness HMR socket 并隔离 Vite 缓存，保留页面错误断言。浏览器启动失败故障注入后测试进程可正常退出，不遗留服务。
- 后端全量一次快照：276 项，274 通过 / 1 失败 / 1 跳过；唯一失败仍为 Windows 对 remembered-sessions 的 Unix 0600 mode 断言，未放宽或伪造通过。本机封面 Python 环境已配置，封面渲染本轮全量通过。后续补测新增用例见上面的最终相关 72 项。
- 构建成功（144 模块，仅既有 chunk 体积警告）；版本检查以并发维护的 1.27.7 为准并通过，构建产物内版本也为 1.27.7。本会话没有发布该版本或部署迁移，未覆盖独立的 1.27.7 录制启动修复条目。
- 本轮仅模拟网络/临时数据测试，没有真实付费 API、登录凭据或生产数据操作。SHA-256 快照保存于 `staging/summarizer-round2.SHA256SUMS`；首轮快照单独保留，均不替代正式发布清单。

## 第二十四批：差距表与证据归档

- 差距表补记第七～二十三批的实际落点：分析来源清单（JSON/Markdown/CSV、单人/整批、仅主机名脱敏）、队列健康统计、清空重来、离线 small 档、公开回放字段收敛、日文翻译目标与日文字幕轨、双语导出与证据译文对照。
- 「邀请账号」与界面多语言仍未实现，表中保留为未完成项，不以已有功能替代说明。
- 验证基线（截至第二十三批，全部为本机模拟数据）：后端全量 339 项 338 通过 / 0 失败 / 1 跳过；前端全量并发 4 共 94 项全通过；`node scripts/version.mjs check` PASS（1.27.7）。
- 已定位并修复两个长期被记为「环境问题」的失败：Windows 会话文件 mode 断言（改为平台感知 + POSIX 显式 chmod）与封面渲染器缺少 `COVER_PYTHON_BIN`（本机 Python 实跑通过）。
- 前端并发抖动根因是 Vite HMR 默认端口 24678 被并行夹具占用，只在测试夹具噪声层面过滤，页面其它异常仍会让用例失败。
## 下一轮起点

1. 迁移严格官方分享链接→回放元数据预览→去重分析任务的完整流程，先核对已有 replay-import，避免重复下载整场视频或建立任意 URL 代理。
2. 核对成员词库热词指纹、自动翻译队列与精细剪辑差距；现有队列为这些适配器保留安全预算和断点机制。
3. Linux 候选环境须验 remembered-sessions 权限与单实例锁；如需容器 crash 自动恢复，另行采用内核锁适配或经过验证的耐久任务后端，不得把本地 PID 锁误当分布式方案。
4. 正式发布前重新版本化、完整候选回归、生成正式哈希清单，再经明确授权发布。

后续轮次继续更新本任务板，不把部分迁移标为总体完成。
