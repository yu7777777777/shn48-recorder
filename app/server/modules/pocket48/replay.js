"use strict";

const pocket48 = require("./api");
const liveService = require("./live");

const CACHE_TTL_MS = Math.max(60_000, Number(process.env.REPLAY_METADATA_CACHE_TTL_MS) || 60 * 60 * 1000);
const CACHE_MAX = Math.max(100, Number(process.env.REPLAY_METADATA_CACHE_MAX) || 2000);
const metadataCache = new Map();
const TEAM_SCAN_PAGE_LIMIT = 12;
const TEAM_PAGE_SIZE = 20;
const MEMBER_SEARCH_LIMIT = 30;
const MEMBER_SEARCH_PAGE_LIMIT = 4;
const TEAM_IDS_BY_GROUP = Object.freeze({
  "10": new Set(["sii", "nii", "hii", "x", "trainee"]),
  "11": new Set(["b", "e", "trainee"]),
  "12": new Set(["g", "niii", "z", "trainee"]),
  "14": new Set(["c", "k", "trainee"]),
  "21": new Set(["cii", "gii", "trainee"]),
});

function contentOf(result) {
  return liveService._internals.contentOf(result);
}

function firstValue(obj, keys) {
  return liveService._internals.firstValue(obj, keys);
}

function rawReplayList(result) {
  const content = contentOf(result);
  const candidates = [content.liveList, content.list, content.items, Array.isArray(content) ? content : null];
  return candidates.find(Array.isArray) || [];
}

function durationSeconds(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part)) || numbers.slice(1).some((part) => part >= 60)) return null;
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

function normalizeTeam(raw = {}) {
  const user = raw.userInfo || raw.memberInfo || raw.user || raw.owner || {};
  const logo = String(firstValue(user, ["teamLogo", "team_logo"]) || "").toLowerCase();
  if (!logo) return null;
  if (logo.includes("snh48_team_yubeisheng")) return { id: "trainee", name: "预备生" };

  const logoName = logo.split("/").pop() || "";
  const exactTeams = {
    "snh48_s2.png": { id: "sii", name: "Team SII" },
    "snh48_n2.png": { id: "nii", name: "Team NII" },
    "snh48_h2.png": { id: "hii", name: "Team HII" },
    "snh48_x.png": { id: "x", name: "Team X" },
    "bej48_b.png": { id: "b", name: "Team B" },
    "bej48_e.png": { id: "e", name: "Team E" },
    "gnz48_g.png": { id: "g", name: "Team G" },
    "gnz48_n3.png": { id: "niii", name: "Team NIII" },
    "gnz_z_log2.png": { id: "z", name: "Team Z" },
    "ckg_c.png": { id: "c", name: "Team C" },
    "ckg_k.png": { id: "k", name: "Team K" },
    "4gskw7gl929o9291nfpso16.png": { id: "gii", name: "Team GII" },
    "7qwq0z2kvtmpumdxeqsv6c3.png": { id: "cii", name: "Team CII" },
  };
  return exactTeams[logoName] || null;
}

function isTeamInGroup(groupId, teamId) {
  return TEAM_IDS_BY_GROUP[String(groupId)]?.has(String(teamId)) || false;
}

function normalizeReplay(raw) {
  const live = liveService.normalizeLive(raw || {});
  // Upstream gates public replay work on review=true plus a non-empty stream
  // path. An ENDLIST in the HLS manifest is not the same as Pocket48 having
  // published the recording, so keep the raw public flag. Missing means false.
  const review = firstValue(raw, ["review"]);
  const streamPath = firstValue(raw, ["playStreamPath", "playUrl", "streamPath"]);
  const durationValue = firstValue(raw, ["duration", "recordDuration", "length"]);
  return {
    liveId: live.liveId,
    title: live.title,
    cover: live.cover,
    startedAt: live.startedAt,
    duration: durationValue === null ? "" : String(durationValue),
    durationSeconds: durationSeconds(durationValue),
    liveType: firstValue(raw, ["liveType", "type"]),
    liveMode: firstValue(raw, ["liveMode"]),
    status: firstValue(raw, ["status"]),
    member: live.member,
    team: normalizeTeam(raw),
  };
}

// The public DTO is a whitelist: review and streamPath are gating inputs for the
// private import path, not content a public replay view should echo back.
function publicReplay(raw) {
  const value = normalizeReplay(raw);
  const { liveId, title, cover, startedAt, duration, durationSeconds, liveType, liveMode, status, member, team } = value;
  return { liveId, title, cover, startedAt, duration, durationSeconds, liveType, liveMode, status, member, team };
}

function cacheReplay(replay) {
  if (!replay.liveId) return;
  metadataCache.delete(replay.liveId);
  metadataCache.set(replay.liveId, { replay, expiresAt: Date.now() + CACHE_TTL_MS });
  while (metadataCache.size > CACHE_MAX) metadataCache.delete(metadataCache.keys().next().value);
}

function cachedReplay(liveId) {
  const entry = metadataCache.get(String(liveId));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    metadataCache.delete(String(liveId));
    return null;
  }
  return entry.replay;
}

function responseNext(result) {
  return String(firstValue(contentOf(result), ["next", "nextTime", "nextId"]) || "0");
}

function memberIdOf(raw) {
  const user = raw?.userInfo || raw?.user || {};
  return String(firstValue(user, ["userId", "memberId", "id"]) || "");
}

function danmakuUrlOf(raw = {}) {
  const value = firstValue(raw, ["msgFilePath", "messageFilePath", "danmakuFilePath"]);
  return value === null ? "" : String(value || "").trim();
}

async function listReplays({ next = "0", groupId, userId, teamId, limit } = {}) {
  let firstReplay = null;
  let effectiveNext = String(next || "0");
  const resultLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(MEMBER_SEARCH_LIMIT, Math.floor(Number(limit))))
    : null;

  // Pocket48 returns an empty first page for userId + next=0. Both mature
  // 48tools implementations seed the filtered query with the global newest id.
  if (userId !== undefined && userId !== null && userId !== "" && effectiveNext === "0") {
    const firstResult = await pocket48.getReplayListPage({ next: "0" });
    liveService._internals.assertSuccessfulResult(firstResult);
    const newest = rawReplayList(firstResult)[0];
    if (newest?.liveId) {
      effectiveNext = String(newest.liveId);
      if (memberIdOf(newest) === String(userId)) firstReplay = newest;
    }
  }

  const seen = new Set();
  const list = [];
  let pageCount = 0;
  let responseCursor = effectiveNext;

  do {
    const result = await pocket48.getReplayListPage({ next: effectiveNext, groupId, userId });
    liveService._internals.assertSuccessfulResult(result);
    const rawList = rawReplayList(result);
    if (firstReplay) {
      rawList.unshift(firstReplay);
      firstReplay = null;
    }

    rawList.map(normalizeReplay).forEach((item) => {
      if (!item.liveId || seen.has(item.liveId)) return;
      seen.add(item.liveId);
      cacheReplay(item);
      if (!teamId || item.team?.id === String(teamId)) list.push(item);
    });

    responseCursor = responseNext(result);
    effectiveNext = responseCursor;
    pageCount += 1;
  } while (
    ((teamId && list.length < TEAM_PAGE_SIZE)
      || (resultLimit && list.length < resultLimit)) &&
    responseCursor !== "0" &&
    pageCount < (resultLimit ? MEMBER_SEARCH_PAGE_LIMIT : TEAM_SCAN_PAGE_LIMIT)
  );

  return { list: resultLimit ? list.slice(0, resultLimit) : list, next: responseCursor };
}

async function getReplay(liveId) {
  const result = await pocket48.getReplayOne(liveId);
  liveService._internals.assertSuccessfulResult(result);
  const raw = contentOf(result);
  const detail = normalizeReplay(raw);
  const danmakuUrl = danmakuUrlOf(raw);
  detail.hasDanmaku = Boolean(danmakuUrl);
  if (!detail.liveId) detail.liveId = String(liveId);
  const cached = cachedReplay(detail.liveId);
  if (cached) {
    detail.duration = cached.duration;
    detail.durationSeconds = cached.durationSeconds;
    if (!detail.startedAt) detail.startedAt = cached.startedAt;
    if (!detail.cover) detail.cover = cached.cover;
  }
  cacheReplay(detail);
  // Public callers get the whitelisted shape; gating flags stay internal.
  return { replay: publicReplay(detail), streamUrl: liveService.findStreamUrl(raw), danmakuUrl };
}

// The single-replay endpoint usually omits duration. Historical audits need the
// duration from the member's replay list, matched by the exact live ID.
async function findReplayMetadata(liveId, userId, { maxPages = 12 } = {}) {
  const target = String(liveId || "");
  const member = String(userId || "");
  if (!/^\d{1,30}$/.test(target) || !/^\d{1,30}$/.test(member)) return null;
  const cached = cachedReplay(target);
  if (cached?.durationSeconds) return cached;

  const newestPage = await pocket48.getReplayListPage({ next: "0" });
  liveService._internals.assertSuccessfulResult(newestPage);
  const newest = rawReplayList(newestPage)[0];
  if (!newest?.liveId) return null;
  if (String(newest.liveId) === target && memberIdOf(newest) === member) {
    const found = normalizeReplay(newest);
    cacheReplay(found);
    return found;
  }

  let next = String(newest.liveId);
  const visited = new Set();
  for (let page = 0; page < Math.max(1, Math.min(30, maxPages)); page += 1) {
    if (visited.has(next)) break;
    visited.add(next);
    const result = await pocket48.getReplayListPage({ next, userId: member });
    liveService._internals.assertSuccessfulResult(result);
    const rawList = rawReplayList(result);
    for (const raw of rawList) {
      const item = normalizeReplay(raw);
      cacheReplay(item);
      if (item.liveId === target) return item;
    }
    if (!rawList.length || rawList.every(raw => /^\d+$/.test(String(raw.liveId || "")) && BigInt(raw.liveId) < BigInt(target))) break;
    const cursor = responseNext(result);
    if (cursor === "0" || cursor === next) break;
    next = cursor;
  }
  return null;
}

// Anonymous label lookup. Pocket48 replays carry only a member id, so the
// public member directory is consulted once per id; transient failures leave
// the label empty rather than blocking the replay itself.
async function memberLabel(memberId) {
  const id = String(memberId || "");
  if (!/^\d{1,30}$/.test(id)) return "";
  try {
    const members = require("./members");
    const roster = await members.listRoster();
    const row = (Array.isArray(roster?.list) ? roster.list : []).find(item => String(item?.memberId) === id);
    return String(row?.memberName || "").trim();
  } catch { return ""; }
}

module.exports = {
  listReplays,
  getReplay,
  memberLabel,
  findReplayMetadata,
  normalizeReplay,
  publicReplay,
  normalizeTeam,
  isTeamInGroup,
  durationSeconds,
  _internals: { rawReplayList, metadataCache, cachedReplay, responseNext, memberIdOf, danmakuUrlOf, TEAM_IDS_BY_GROUP, MEMBER_SEARCH_LIMIT },
};
