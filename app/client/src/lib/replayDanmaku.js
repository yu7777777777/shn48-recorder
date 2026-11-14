function clean(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeReplayDanmaku(message = {}) {
  const id = clean(message.id, 80);
  const nickname = clean(message.nickname, 32) || "观众";
  const text = clean(message.text, 160);
  const atMs = Number(message.atMs);
  if (!id || !text || !Number.isSafeInteger(atMs) || atMs < 0) return null;
  return { id, atMs, nickname, text };
}

export function normalizeReplayDanmakuList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeReplayDanmaku).filter(Boolean).sort((left, right) => left.atMs - right.atMs);
}

export function firstMessageAfter(messages, atMs) {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (messages[middle].atMs <= atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function replayDanmakuAt(messages, atMs, limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const end = firstMessageAfter(messages, Math.max(0, Number(atMs) || 0));
  return messages.slice(Math.max(0, end - safeLimit), end);
}
