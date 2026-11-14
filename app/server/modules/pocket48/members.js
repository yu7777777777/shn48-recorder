"use strict";

// The old Pocket48 `/user/api/v1/group/list` and `/member/list` routes now
// return 404, and the old `h5.snh48.com/resource/jsonp/members.php` directory
// went down wholesale (every group answered 502 on 2026-10-24). The official
// site now loads its roster from `h5.48.cn/resource/json/allmembers_0.jsonp`,
// which carries group, team and Pocket48 id in one payload, so it is the
// primary source. The room map remains a last resort that at least keeps the
// roster usable. None of these sources receives the signed-in user's token.
const CACHE_MS = 6 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DIRECTORY_IDS = [10, 20, 30, 40, 50, 60, 70];
const GROUP_NAMES = new Map([
  ["10", "SNH48"],
  ["20", "BEJ48"],
  ["30", "GNZ48"],
  ["40", "SHY48"],
  ["50", "CKG48"],
  ["60", "CGT48"],
  ["70", "IDFT"],
]);
const OFFICIAL_DIRECTORY_URL = process.env.POCKET48_OFFICIAL_DIRECTORY_URL || "https://h5.48.cn/resource/json/allmembers_0.jsonp";
const DIRECTORY_URL = process.env.POCKET48_MEMBER_DIRECTORY_URL || "http://h5.snh48.com/resource/jsonp/members.php?gid={groupId}";
const ROOM_MAP_URL = process.env.POCKET48_ROOM_MAP_URL || "https://abm48.com/api/public/snh48/room-map";
let cache = null;

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `48tools/${require("../../lib/version").version()}` },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Member directory HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Member directory response is too large");
  return text;
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try { return JSON.parse(text); } catch { throw new Error("Member directory returned invalid JSON"); }
}

// The official payload is JSONP (`get_members_success({...})`). Tolerate a bare
// JSON body too, so a future switch away from the callback wrapper keeps working.
function parseJsonp(text) {
  const trimmed = String(text || "").trim();
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  const body = start >= 0 && end > start ? trimmed.slice(start + 1, end) : trimmed;
  try { return JSON.parse(body); } catch { throw new Error("Member directory returned invalid JSON"); }
}

function officialDirectoryUrl() {
  return OFFICIAL_DIRECTORY_URL;
}

function directoryUrl(groupId) {
  return DIRECTORY_URL.replace("{groupId}", encodeURIComponent(String(groupId)));
}

function teamLabel(team, groupName) {
  const value = String(team || "未分队").trim() || "未分队";
  if (value === groupName || value === groupName.replace("48", "")) return "未分队";
  if (/^(?:SII|NII|HII|X|XII|B|E|J|G|NIII|Z|SIII|HIII|C|K|CII|GII)$/i.test(value)) return `Team ${value}`;
  if (value.toLowerCase() === "idft") return "IDFT";
  return value;
}

function normalizeDirectoryMember(raw, roomMap) {
  // `status` is absent from the current official payload and was "99" for
  // active members in the retired one; only an explicitly non-99 value (a
  // graduated or delisted member) is rejected.
  if (!raw) return null;
  if (raw.status !== undefined && String(raw.status) !== "99") return null;
  const memberName = String(raw.sname || raw.name || "").trim();
  const officialId = String(raw.pocket_id ?? "").trim();
  const mappedId = memberName && roomMap && String(roomMap[memberName] ?? "").trim();
  const memberId = officialId && officialId !== "0" ? officialId : mappedId;
  if (!memberName || !memberId || memberId === "0") return null;
  const directoryGroupId = String(raw.gid ?? "").trim();
  const groupRoot = GROUP_NAMES.get(directoryGroupId) || String(raw.gname || "48Group").trim();
  const teamId = String(raw.tid || raw.tname || "ungrouped").trim();
  const groupId = `${directoryGroupId}:${teamId}`;
  const groupName = `${groupRoot} · ${teamLabel(raw.tname, groupRoot)}`;
  return { memberId, memberName, groupId, groupName, groupIds: [groupId], groupNames: [groupName] };
}

function mergeMember(target, incoming) {
  if (!target) return incoming;
  for (const id of incoming.groupIds) if (!target.groupIds.includes(id)) target.groupIds.push(id);
  for (const name of incoming.groupNames) if (!target.groupNames.includes(name)) target.groupNames.push(name);
  target.groupId = target.groupIds[0];
  target.groupName = target.groupNames.join(" / ");
  return target;
}

function findMembersByName(list, value, maxResults = 5) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  if (!query || !Array.isArray(list)) return [];
  const normalized = query.toLocaleLowerCase("zh-CN");
  const matches = list.filter((member) => String(member.memberName || "").trim().toLocaleLowerCase("zh-CN").includes(normalized));
  const exact = matches.find((member) => String(member.memberName || "").trim().toLocaleLowerCase("zh-CN") === normalized);
  return exact ? [exact] : matches.slice(0, Math.max(1, maxResults));
}

function findMemberByName(list, value) {
  const matches = findMembersByName(list, value, 2);
  // Keep this singular helper conservative for callers that must select one
  // exact member.  Public replay search deliberately uses the plural helper.
  return matches.length === 1 ? matches[0] : null;
}

// h5.snh48.com has gone down wholesale (every group answers 502), which used to
// leave the automation page with no selectable members at all despite the room
// map still listing everyone. Build a roster straight from the room map when no
// directory can be read, so recording can still be configured; these members
// carry no group or team, and are labelled as such rather than mis-filed.
function rosterFromRoomMap(roomMap) {
  const all = new Map();
  for (const [name, id] of Object.entries(roomMap || {})) {
    const memberName = String(name || "").trim();
    const memberId = String(id ?? "").trim();
    if (!memberName || !memberId || memberId === "0" || !/^\d+$/.test(memberId)) continue;
    const member = { memberId, memberName, groupId: "ungrouped", groupName: "未分组", groupIds: ["ungrouped"], groupNames: ["未分组"] };
    all.set(member.memberId, mergeMember(all.get(member.memberId), member));
  }
  return all;
}

// `requestJson` is the injectable fetcher used by tests and by both real sources.
// `requestText` is only used by the JSONP official endpoint.
async function listRoster({ force = false, requestJson = fetchJson, requestText = fetchText } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  // The room map is optional now: the official payload already carries every
  // Pocket48 id, so a third-party outage must not take the roster down with it.
  let roomMap = {};
  try {
    const loaded = await requestJson(ROOM_MAP_URL);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) roomMap = loaded;
  } catch { /* ids come from the official payload; the map only fills gaps */ }

  const collect = (rows, target = new Map()) => {
    for (const raw of Array.isArray(rows) ? rows : []) {
      const member = normalizeDirectoryMember(raw, roomMap);
      if (member) target.set(member.memberId, mergeMember(target.get(member.memberId), member));
    }
    return target;
  };

  let all = new Map();
  let source = null;
  let failure = null;

  // 1. Official single-payload directory (group + team + Pocket48 id together).
  try {
    const payload = parseJsonp(await requestText(officialDirectoryUrl()));
    all = collect(payload && payload.rows);
    if (all.size) source = "official";
    else failure = new Error("Pocket48 member directory is empty");
  } catch (error) {
    failure = error;
  }

  // 2. Retired per-group directory, kept because it may come back and because
  // some deployments point POCKET48_MEMBER_DIRECTORY_URL at a mirror.
  if (!all.size) {
    try {
      for (const groupId of DIRECTORY_IDS) collect((await requestJson(directoryUrl(groupId)))?.rows, all);
      if (all.size) source = "directory";
    } catch (error) {
      failure = error;
    }
  }

  // 3. Last resort: names and ids only, with no group or team information.
  let fallback = false;
  if (!all.size && Object.keys(roomMap).length) {
    all = rosterFromRoomMap(roomMap);
    fallback = all.size > 0;
    if (fallback) source = "room-map";
  }
  if (!all.size) throw failure || new Error("Pocket48 member directory is empty");

  const list = [...all.values()].sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN") || a.memberName.localeCompare(b.memberName, "zh-CN"));
  const groupMap = new Map();
  for (const member of list) member.groupIds.forEach((id, index) => groupMap.set(id, member.groupNames[index]));
  const groups = [...groupMap].map(([groupId, groupName]) => ({ groupId, groupName })).sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN"));
  const value = { list, next: null, groups, fallback, source };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = {
  listRoster,
  findMemberByName,
  findMembersByName,
  normalizeDirectoryMember,
  rosterFromRoomMap,
  parseJsonp,
  _internals: {
    CACHE_MS,
    DIRECTORY_IDS,
    OFFICIAL_DIRECTORY_URL,
    officialDirectoryUrl,
    parseJsonp,
    fetchText,
    ROOM_MAP_URL,
    directoryUrl,
    fetchJson,
    mergeMember,
    findMemberByName,
    findMembersByName,
    teamLabel,
    clearCache: () => { cache = null; },
  },
};
