---
description: 向成员翻牌提问，或查看/撤回历史提问
argument-hint: "<成员名> <问题>｜list｜delete <questionId>"
allowed-tools: Bash(node:*)
---

> CLI 入口是 `node "$CLAUDE_PLUGIN_ROOT/cli.js"`（仓库内开发时是 `node bin/snh48.js`）。
> 下文简写的 `snh48 …` 都要替换成它——`snh48` 并不在 PATH 里。

用 `snh48` 操作翻牌。**提问要花用户的鸡腿/星币**，务必先确认再发。

参数：`$ARGUMENTS`。

## 查看历史提问

`$ARGUMENTS` 是 `list`（或为空）时：`snh48 flip list --limit 20 --json`，
整理成「时间 / 成员 / 问题 / 是否已翻」。

## 提问（花钱）

第一个词是成员、其余是问题时：

1. **查价**：`snh48 flip prices <成员> --json`。返回的 `customs` 数组里每档
   `answerType`（1文字/2语音/3视频）对应三种可见性花费：`normalCost`(公开)、
   `privateCost`(私密)、`anonymityCost`(匿名)，把用户关心的那档念给用户——
   **不要**自己替用户挑贵的。
2. **复述并等确认**：念一遍「向谁、问什么、哪种回答类型、公开/私密/匿名、花多少」，
   问「确认提问吗？」。用户明确同意后才继续。
3. **提问**：`snh48 flip ask <成员> <问题> --price <鸡腿数> --type <1文字|2语音|3视频> --privacy <1公开|2私密|3匿名>`。
   `--type` 不带时默认 1（文字），`--privacy` 不带时默认 2（私密）；
   用户没指定时也要在第 2 步说明默认值是什么。
4. 回报结果，附上返回的 `question`。

> 历史遗留提醒：早期版本这里错误地把请求字段写成了 `question`/`questionType`/`priceId`，
> 且完全没传口袋 48 服务端要求的可见性字段 `type`（公开/私密/匿名），导致服务端收到
> 无法识别的结构后只会兜底返回 `系统繁忙，请稍后再试`，很容易被误判成网络或风控问题。
> 正确字段名参考自官方桌面客户端“牙牙消息”源码（`content`/`type`/`cost`/`answerType`，
> 且 `memberId` 必须是 number）：https://github.com/yk1z/yaya_msg
> `src/common/pocket-runtime.mjs` 的 `sendFlipQuestion()`。

## 撤回提问

`$ARGUMENTS` 是 `delete <questionId>` 时，先确认要撤的是哪一条（必要时先 `flip list`），
再跑 `snh48 flip delete <questionId> --json`。

## 通用

失败时先读 `hint`。报「尚未登录」就跑 `snh48 login status --json` 确认状态，
再把登录步骤交给用户——短信验证码只发到他们手机上。
