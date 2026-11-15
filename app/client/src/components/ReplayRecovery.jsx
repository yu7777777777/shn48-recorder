// 官方回放补全进行中的状态集合。只被归档页与 115 备份卡用来判断
// 「回放核对尚未结束，相关操作要等待」；原详情页组件已随 2.0.0 移除。
export const replayWorking = item => ["pending", "downloading", "verifying", "waiting_replay", "awaiting_archive"].includes(item?.replayRecovery?.status);
