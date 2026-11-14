"use strict";
// Public member-to-channel index. Never send account credentials to this host.
//
// This is the roster the follow manager renders: every member the upstream
// community directory knows about (962 rows, a superset of the 528-row
// jsdelivr list), annotated with the `roomId` needed to open their room.
// It is a public read; following/unfollowing happens against the Pocket48
// account through `api.js`, never here.
let cached = null, expires = 0, pending;
const validId = value => /^\d{1,30}$/.test(String(value || ''));

// Team display order, mirroring the upstream client so the grouped list reads
// the same way. Unknown teams sort after the known ones, keeping their own
// label rather than being dropped.
const TEAM_ORDER = [
  "TEAM SII", "TEAM NII", "TEAM HII", "TEAM X",
  "TEAM B", "TEAM E", "TEAM J", "BEJ48",
  "TEAM G", "TEAM NIII", "TEAM Z", "TEAM C", "TEAM K", "CKG48",
  "TEAM CII", "TEAM GII", "预备生", "IDFT", "荣誉毕业生",
  "", "燃烧吧团魂", "丝芭影视", "官方",
];
function teamRank(team) {
  const index = TEAM_ORDER.indexOf(team);
  return index < 0 ? TEAM_ORDER.length : index;
}

function memberRows(data) {
  // The live document is a bare array OR an object wrapped under "roomId".
  // Both shapes were observed from the same URL on the same day (2026-10-20);
  // neither key was the one 1.21.0 looked at.
  if (Array.isArray(data)) return data;
  for (const key of ['roomId', 'members', 'memberList', 'data']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}

async function directory() {
  if (cached && Date.now() < expires) return cached;
  if (!pending) pending = (async () => {
    const response = await fetch('https://data.gnz.hk/members.json', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Member directory unavailable (HTTP ' + response.status + ')');
    // Read the body as text first: Cloudflare's bot challenge answers 200 with an
    // HTML page, and response.json() would turn that into a parser error that
    // says nothing about the real cause. Tests stub fetch with a json()-only
    // response, so that path is kept as a fallback.
    let data;
    if (typeof response.text === 'function') {
      const body = await response.text();
      try { data = JSON.parse(body); }
      catch {
        throw new Error(/just a moment|challenge|cf-browser/i.test(body)
          ? 'Member directory is behind a Cloudflare challenge (HTTP 200 HTML), not JSON'
          : 'Member directory is not JSON (HTTP ' + response.status + ')');
      }
    } else {
      data = await response.json();
    }
    const rows = memberRows(data);
    if (!rows) {
      throw new Error('Invalid member directory (unexpected shape: ' + (Array.isArray(data) ? 'array' : 'object keys ' + Object.keys(data || {}).slice(0, 6).join(',')) + ')');
    }
    cached = rows.filter(r => validId(r.id) && validId(r.channelId) && validId(r.serverId))
      .map(r => ({
        ownerId: String(r.id),
        ownerName: typeof r.ownerName === 'string' ? r.ownerName.trim() : '',
        pinyin: typeof r.pinyin === 'string' ? r.pinyin : '',
        groupName: typeof r.groupName === 'string' ? r.groupName.trim() : '',
        channelId: String(r.channelId),
        serverId: String(r.serverId),
        // The public directory has NO numeric roomId column (verified against a
        // live 531-row fetch: only id/channelId/serverId). The QChat channelId IS
        // the room identifier that /rooms/:id/messages resolves from, so expose
        // it under that name rather than shipping an empty string that disables
        // every row in the UI.
        roomId: validId(r.roomId) ? String(r.roomId) : String(r.channelId),
        teamName: typeof r.team === 'string' ? r.team.trim() : '',
      }));
    expires = Date.now() + 3600000;
    return cached;
  })().finally(() => { pending = null; });
  return pending;
}
async function resolve(roomId, ownerId) {
  const rows = await directory();
  // Conversation room IDs and QChat channel IDs belong to separate namespaces.
  return ownerId ? rows.find(r => r.ownerId === String(ownerId)) : rows.find(r => r.channelId === String(roomId));
}

// Whole roster grouped by team, in upstream display order. Names that repeat
// are disambiguated by the caller; ids are unique.
async function roster() {
  const rows = await directory();
  const groups = new Map();
  for (const row of rows) {
    const key = row.teamName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([teamName, members]) => ({
      teamName,
      members: members.slice().sort((a, b) => a.ownerName.localeCompare(b.ownerName, 'zh-Hans-CN')),
    }))
    .sort((a, b) => teamRank(a.teamName) - teamRank(b.teamName));
}

module.exports = { resolve, roster, memberRows, TEAM_ORDER };
