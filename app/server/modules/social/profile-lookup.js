"use strict";

// Public, anonymous profile lookup only. No storage, cookie jar, login fallback,
// raw-input fetch target, redirects, HTML scraping or signed/private APIs.
const { normalizeAccountId, profileUrl } = require("./accounts");

const LIMITS = Object.freeze({ timeoutMs: 5000, maxBytes: 128 * 1024, cacheTtlMs: 300000, maxCache: 100, maxConcurrent: 3, perMinute: 20 });
const MESSAGES = Object.freeze({
  restricted: "平台公开接口暂不可读取（可能需要登录、验证或受到访问限制），请手动填写昵称",
  failed: "暂未取得与该账号匹配的公开昵称，请确认账号或手动填写",
  timeout: "公开昵称查询超时，请稍后重试或手动填写",
  busy: "查询较频繁或服务繁忙，请稍后重试或手动填写",
});

function invalid(message = "账号 ID 无效，请填写该平台的账号 ID 或已知主页链接") {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.platform !== "string" || !["weibo", "bilibili", "xiaohongshu", "douyin"].includes(input.platform)) {
    throw invalid("平台类型无效或不支持昵称查询");
  }
  const raw = input.accountId;
  if (!(typeof raw === "string" || (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0))) throw invalid();
  if (String(raw).length > 4096 || /[\x00-\x1f\x7f]/.test(String(raw))) throw invalid();
  // Reuse the account book's strict, local-only homepage parsing. Never turn
  // its permissive manual-name support into an arbitrary network destination.
  const accountId = normalizeAccountId(raw, input.platform);
  if (String(raw).trim().length > 160 && !/[/:?#]/.test(String(raw))) throw invalid();
  if (!/^[\p{L}\p{N}_.-]{1,160}$/u.test(accountId)) throw invalid();
  if (["weibo", "bilibili"].includes(input.platform) && /^\d+$/.test(accountId) && !/^\d{1,20}$/.test(accountId)) throw invalid();
  if (input.platform === "bilibili" && !/^\d{1,20}$/.test(accountId)) throw invalid();
  if (/^0+$/.test(accountId)) throw invalid();
  return { platform: input.platform, accountId };
}

// All network targets are constructed here from validated numeric IDs. Host,
// protocol, path and query keys are constant; tracking input never survives.
function targets(platform, id) {
  if (!/^\d{1,20}$/.test(id)) return [];
  if (platform === "weibo") return [
    `https://m.weibo.cn/api/container/getIndex?type=uid&value=${id}`,
    `https://weibo.com/ajax/profile/info?uid=${id}`,
  ];
  if (platform === "bilibili") return [`https://api.bilibili.com/x/web-interface/card?mid=${id}`];
  return [];
}

function sameId(actual, expected) {
  if (typeof actual !== "string" && !(typeof actual === "number" && Number.isSafeInteger(actual))) return false;
  return /^\d{1,20}$/.test(String(actual)) && String(actual).replace(/^0+/, "") === expected.replace(/^0+/, "");
}

function evidenceName(json, platform, id) {
  // Require a successful envelope and matching UID, not just a page title/name.
  const user = platform === "bilibili" ? (json?.code === 0 && json?.data?.card) :
    (json?.ok === 1 && (json?.data?.userInfo || json?.data?.user));
  if (!user || !sameId(platform === "bilibili" ? user.mid : user.id, id)) return "";
  const name = platform === "bilibili" ? user.name : user.screen_name;
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f<>]/.test(name)) return "";
  return name.trim();
}

async function readJson(response, maxBytes, signal) {
  const cancel = () => { try { const result = response.body?.cancel(); result?.catch(() => {}); } catch {} };
  if (response.status !== 200 || !/\bapplication\/json\b/i.test(response.headers.get("content-type") || "")) {
    cancel();
    throw new Error("restricted");
  }
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { cancel(); throw new Error("restricted"); }
  if (!response.body?.getReader) throw new Error("restricted");
  const reader = response.body.getReader();
  const cancelReader = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelReader, { once: true });
  const chunks = [];
  let size = 0;
  try {
    if (signal.aborted) throw new Error("timeout");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("timeout");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("restricted");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    // Do not await a remote stream's cancellation: the wall-clock deadline
    // applies even to a stalled body or an injected non-cooperative transport.
    signal.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}

function createProfileLookup({ fetch: fetchImpl = globalThis.fetch, now = Date.now, limits = {} } = {}) {
  const config = { ...LIMITS, ...limits };
  const cache = new Map();
  const pending = new Map();
  let windowStart = now();
  let starts = 0;

  async function lookup(input) {
    const { platform, accountId } = normalizeInput(input);
    const base = { accountId, accountName: "", profileUrl: profileUrl({ platform, accountId }), recognized: false, message: "" };
    if (["xiaohongshu", "douyin"].includes(platform)) return { ...base, message: "该平台暂不支持匿名公开昵称识别（可能受登录或验证限制），请手动填写昵称" };
    const urls = targets(platform, accountId);
    if (!urls.length) return { ...base, message: "微博昵称识别需要数字 UID 或数字 UID 主页链接，请手动填写昵称" };
    const key = `${platform}:${accountId}`;
    const time = now();
    for (const [entryKey, entry] of cache) if (entry.expires <= time) cache.delete(entryKey);
    const hit = cache.get(key);
    if (hit) return { ...hit.data };
    if (pending.has(key)) return { ...await pending.get(key) };
    if (time - windowStart >= 60000) { windowStart = time; starts = 0; }
    if (pending.size >= config.maxConcurrent || starts >= config.perMinute) return { ...base, message: MESSAGES.busy };
    starts += 1;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, config.timeoutMs);
    });
    const work = async () => {
      for (const url of urls) {
        if (controller.signal.aborted) throw new Error("timeout");
        try {
          const response = await fetchImpl(url, {
            method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new Error("timeout"); }
          const json = await readJson(response, config.maxBytes, controller.signal);
          const accountName = evidenceName(json, platform, accountId);
          if (accountName) return { ...base, accountName, recognized: true, message: "已从官方公开接口识别昵称，请确认后自行保存" };
        } catch {
          if (controller.signal.aborted) throw new Error("timeout");
          // A second fixed Weibo public endpoint may work when one is limited;
          // never follow redirects or escalate to login/verification bypass.
          continue;
        }
      }
      return { ...base, message: MESSAGES.restricted };
    };
    const task = Promise.race([work(), deadline]).catch(() => ({ ...base, message: controller.signal.aborted ? MESSAGES.timeout : MESSAGES.failed }));
    pending.set(key, task);
    try {
      const data = await task;
      if (data.recognized) {
        if (cache.size >= config.maxCache) cache.delete(cache.keys().next().value);
        cache.set(key, { data, expires: now() + config.cacheTtlMs });
      }
      return { ...data };
    } finally { clearTimeout(timer); pending.delete(key); }
  }
  return lookup;
}

const lookup = createProfileLookup();
module.exports = { lookup, createProfileLookup, LIMITS };
