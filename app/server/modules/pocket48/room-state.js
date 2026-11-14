// 531 members, and nearly half of them can no longer be read: their QChat channel
// is gone upstream and the API answers "频道不存在" (HTTP 200, business status 500).
// Measured on the production roster: 285 readable, 246 revoked.
//
// The roster used to advertise every row as openable, so tapping one of those 246
// produced an error box that looked like a bug in this page. The state is now a
// property of the row, computed once in the background and cached on disk, so the
// member list can mark those rows and group them instead of failing on click.
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "runtime");
const CACHE_FILE = () => path.join(DATA_DIR, "pocket48-room-state.json");
const TTL = 6 * 60 * 60 * 1000;
const CONCURRENCY = 10;

const cache = { at: 0, states: {} };
let running = null;

function load() {
  if (cache.at) return cache;
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8"));
    if (saved && typeof saved === "object" && saved.states) { cache.at = Number(saved.at) || 0; cache.states = saved.states; }
  } catch { /* first run, or the cache was cleared */ }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ at: cache.at, states: cache.states }), "utf8");
  } catch { /* a read-only data dir must not break the page */ }
}

// "ok"    — the channel answered
// "gone"  — the channel is revoked upstream ("频道不存在")
// unknown — not probed yet; the row is treated as readable until we know better
async function probe(api, roomId) {
  try {
    const result = await api.getRoomMessages(roomId, undefined, "all");
    if (result?.status === 200 && result?.data?.status === 200) return "ok";
    const text = String(result?.data?.message || "");
    if (/频道不存在|不存在/.test(text)) return "gone";
    return "unknown";
  } catch { return "unknown"; }
}

async function scan(api, roomIds) {
  const queue = [...roomIds];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      cache.states[id] = await probe(api, id);
    }
  }));
  cache.at = Date.now();
  save();
}

// Returns the state map. Never rejects: an unavailable state is "unknown", not an
// error, because the member list must still render.
async function states(api, roomIds, { refresh = false } = {}) {
  load();
  const stale = Date.now() - cache.at > TTL;
  const missing = roomIds.filter(id => !cache.states[id]);
  if (!refresh && !stale && !missing.length) return cache.states;
  if (!running) {
    const todo = refresh || stale ? roomIds : missing;
    running = scan(api, todo).catch(() => {}).finally(() => { running = null; });
  }
  // Wait briefly so the first paint after a login is usually already labelled,
  // then fall back to whatever is known rather than holding the page hostage.
  await Promise.race([running, new Promise(resolve => setTimeout(resolve, 2500))]);
  return cache.states;
}

module.exports = { states, probe, CACHE_FILE, _reset: () => { cache.at = 0; cache.states = {}; running = null; } };
