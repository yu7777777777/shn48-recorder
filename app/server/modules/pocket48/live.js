"use strict";

const pocket48 = require("./api");

const STREAM_KEYS = [
  "playStreamPath",
  "mergeStreamUrl",
  "streamPath",
  "playUrl",
  "streamUrl",
  "url",
  "liveUrl",
];
const ASSET_BASE = process.env.POCKET48_ASSET_BASE || "https://source3.48.cn/";

function contentOf(result) {
  return (result && result.data && result.data.content) || (result && result.data) || result || {};
}

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return null;
}

function findStreamUrl(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    return /^(?:https?|rtmp):\/\//i.test(value) && /(?:m3u8|\.flv(?:[?#]|$)|live|stream|rtmp)/i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStreamUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const key of STREAM_KEYS) {
    if (typeof value[key] === "string" && /^(?:https?|rtmp):\/\//i.test(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findStreamUrl(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeAssetUrl(value) {
  const first = String(value || "").split(",")[0].trim();
  if (!first) return "";
  try {
    const url = first.startsWith("//") ? new URL(`https:${first}`) : new URL(first, ASSET_BASE);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.protocol === "http:" && (url.hostname === "48.cn" || url.hostname.endsWith(".48.cn"))) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function playbackProtocol(streamUrl) {
  try {
    const url = new URL(streamUrl);
    if (url.protocol === "rtmp:") return "flv";
    const hint = `${url.pathname} ${url.searchParams.get("format") || ""} ${url.searchParams.get("type") || ""}`;
    if (/(?:\.m3u8|\bhls\b)/i.test(hint)) return "hls";
    return "flv";
  } catch {
    return /m3u8|\bhls\b/i.test(String(streamUrl || "")) ? "hls" : "flv";
  }
}

function normalizeLive(raw) {
  const user = raw.userInfo || raw.memberInfo || raw.user || raw.owner || {};
  const liveId = firstValue(raw, ["liveId", "live_id", "id"]);
  return {
    liveId: liveId === null ? "" : String(liveId),
    title: String(firstValue(raw, ["title", "liveTitle", "name"]) || "直播中"),
    cover: normalizeAssetUrl(firstValue(raw, ["coverPath", "cover", "picPath", "image"])),
    startedAt: firstValue(raw, ["startTime", "liveTime", "ctime", "createdAt"]),
    liveType: firstValue(raw, ["liveType", "liveMode", "type"]),
    member: {
      id: String(firstValue(user, ["userId", "memberId", "id"]) || firstValue(raw, ["userId", "memberId"]) || ""),
      name: String(firstValue(user, ["nickname", "name", "userName"]) || firstValue(raw, ["userName", "memberName"]) || ""),
      avatar: normalizeAssetUrl(firstValue(user, ["avatar", "avatarPath", "headImg", "userAvatar"]) || firstValue(raw, ["avatar", "avatarPath"])),
    },
  };
}

function findRoomId(raw) {
  const roomId = String(firstValue(raw, ["roomId", "chatroomId", "chatRoomId"]) || "");
  return /^\d{1,32}$/.test(roomId) ? roomId : "";
}

function extractLiveList(result) {
  const content = contentOf(result);
  const candidates = [content.liveList, content.list, content.items, Array.isArray(content) ? content : null];
  const list = candidates.find(Array.isArray) || [];
  return list.map(normalizeLive).filter((item) => item.liveId);
}

function assertSuccessfulResult(result) {
  if (!result || result.status < 200 || result.status >= 300) {
    throw new Error(`Pocket48 HTTP ${result?.status || "unknown"}`);
  }
  const payload = result.data;
  if (!payload || payload.success === false || (payload.status !== undefined && Number(payload.status) !== 200)) {
    throw new Error(payload?.message || "Pocket48 request failed");
  }
  return payload;
}

async function listLives(groupId = 0, next = "0") {
  const result = await pocket48.getLiveList(groupId, next);
  assertSuccessfulResult(result);
  const content = contentOf(result);
  return {
    list: extractLiveList(result),
    next: firstValue(content, ["next", "nextTime", "nextId"]) || "0",
  };
}

async function getLive(liveId) {
  const result = await pocket48.getOneLive(liveId);
  assertSuccessfulResult(result);
  const raw = contentOf(result);
  const live = normalizeLive(raw);
  if (!live.liveId) live.liveId = String(liveId);
  return { live, raw, roomId: findRoomId(raw), streamUrl: findStreamUrl(raw) };
}

module.exports = {
  listLives,
  getLive,
  normalizeLive,
  extractLiveList,
  findStreamUrl,
  findRoomId,
  normalizeAssetUrl,
  playbackProtocol,
  _internals: { contentOf, firstValue, assertSuccessfulResult, ASSET_BASE },
};
