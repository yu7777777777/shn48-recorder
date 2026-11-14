function clean(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseCustom(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string" || value.length > 16_384) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function safeLiveId(value) {
  const liveId = String(value || "");
  return /^\d{1,32}$/.test(liveId) ? liveId : "";
}

export function normalizeDanmakuMessage(message = {}) {
  if (typeof message.text === "string" && typeof message.nickname === "string" && typeof message.member === "boolean") {
    const id = clean(message.id, 80);
    const text = clean(message.text, 100);
    const nickname = clean(message.nickname, 24) || "观众";
    return id && text ? { id, nickname, text, member: message.member } : null;
  }
  const custom = [message.custom, message.content, message.msg_setting_?.ext_]
    .map(parseCustom).find(Boolean) || {};
  const messageType = String(custom.messageType || "").toUpperCase();
  const isBarrage = messageType === "BARRAGE_NORMAL" || messageType === "BARRAGE_MEMBER";
  const isPlainText = message.type === "text" || Number(message.msg_type_) === 0;
  if (!isBarrage && !isPlainText) return null;

  const text = clean(custom.text || message.text, 100);
  if (!text) return null;
  const nickname = clean(custom.user?.nickName || custom.user?.nickname || message.fromNick || "观众", 24) || "观众";
  const sourceId = clean(message.idClient || message.idServer || message.uuid || "", 80);
  return {
    id: sourceId || `${Number(message.time || message.timetag_ || Date.now())}:${nickname}:${text}`,
    nickname,
    text,
    member: messageType === "BARRAGE_MEMBER",
  };
}
