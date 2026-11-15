// 归档来源渠道的显示名：API 返回的是小写枚举，界面统一用中文显示。
// room_voice（房间上麦）已随 2.0.0 停止新增，仅为历史归档保留显示。
export const SOURCE_LABELS = {
  pocket48: "口袋48",
  room_voice: "房间上麦",
  bilibili: "B站",
};

export function sourceLabel(source) {
  if (!source) return "Pocket48";
  return SOURCE_LABELS[String(source).toLowerCase()] || source;
}
