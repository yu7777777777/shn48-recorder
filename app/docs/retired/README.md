# 已停用的页面组件（归档）

这两个页面都有 `App.jsx` 里的重定向占位路由（`cover-settings` → `/admin/archive`，`room-voice` → `/admin/pocket48`），代码保留在归档目录，方便日后恢复：

- `CoverSettings.jsx`：封面顺序设置已并入归档页。
- `RoomVoice.jsx`：房间语音录制已退役（后端 `modules/pocket48/room-voice` 与 `/api/admin/room-voice` 仍在，用于读取历史音频与消息）。

归档目录不参与 `vite` 构建。恢复时把文件移回 `src/pages` 并重新挂载路由。

`AnalysisProvenanceBatch.jsx` 仍留在 `src/components`：它没有路由入口，但 `client/test/analysis-provenance-batch-ui.test.js` 直接挂载该组件做回归，移出构建范围会让这条用例失去意义。
