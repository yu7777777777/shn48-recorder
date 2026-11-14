// Bilibili 官方接口实现：上传视频文件到 UPOS 并保存为草稿，最后由用户确认发布。
// 接口格式参考 biliup (bilibili/biliup) 源码与 bilibili-API-collect 文档：
//   - preupload:  GET  https://member.bilibili.com/preupload
//   - 分片上传:    PUT  https://{endpoint}/{upos_uri}?uploads&output=json
//   - 合片/取信息: POST https://{endpoint}/{upos_uri}?name=...&uploadId=...
//   - 保存草稿:    POST https://member.bilibili.com/x/vupre/web/draft/add
//   - 草稿列表:    GET  https://member.bilibili.com/x/vupre/web/draft/list
//   - 草稿详情:    GET  https://member.bilibili.com/x/vupre/web/draft/view
//   - 发布:        POST https://member.bilibili.com/x/vu/web/add/v3
//
// 除生产地址外，支持通过环境变量覆盖地址，便于用本地 mock 服务器做管线测试。

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_PREUPLOAD_URL =
  process.env.BILI_PREUPLOAD_URL || "https://member.bilibili.com/preupload";
const DEFAULT_DRAFT_URL =
  process.env.BILI_DRAFT_URL ||
  "https://member.bilibili.com/x/vupre/web/draft/add";
const DEFAULT_DRAFT_LIST_URL =
  process.env.BILI_DRAFT_LIST_URL ||
  "https://member.bilibili.com/x/vupre/web/draft/list";
const DEFAULT_DRAFT_VIEW_URL =
  process.env.BILI_DRAFT_VIEW_URL ||
  "https://member.bilibili.com/x/vupre/web/draft/view";
const DEFAULT_ADD_URL =
  process.env.BILI_ADD_URL || "https://member.bilibili.com/x/vu/web/add/v3";

function preuploadUrl() {
  return process.env.BILI_PREUPLOAD_URL || DEFAULT_PREUPLOAD_URL;
}
function draftUrl() {
  return process.env.BILI_DRAFT_URL || DEFAULT_DRAFT_URL;
}
function draftListUrl() {
  return process.env.BILI_DRAFT_LIST_URL || DEFAULT_DRAFT_LIST_URL;
}
function draftViewUrl() {
  return process.env.BILI_DRAFT_VIEW_URL || DEFAULT_DRAFT_VIEW_URL;
}
function addUrl() {
  return process.env.BILI_ADD_URL || DEFAULT_ADD_URL;
}

const DEFAULT_VERSION = "2.14.0";
const DEFAULT_BUILD = 2140000;
const MAX_CHUNK_RETRY = 3;
const DEFAULT_UPCDN = "bda2";

// ---------------------------------------------------------------------------
// Cookie / 凭据
// ---------------------------------------------------------------------------

function loadCredentials(cookiesPath) {
  const raw = fs.readFileSync(cookiesPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error("Cookie 文件不是有效的 JSON: " + err.message);
  }
  if (!data || typeof data !== "object") {
    throw new Error("Cookie 文件内容无效");
  }

  const map = {};
  const cookieInfo = data.cookie_info;
  if (cookieInfo && Array.isArray(cookieInfo.cookies)) {
    for (const c of cookieInfo.cookies) {
      if (c && c.name) map[c.name] = c.value;
    }
  } else if (Array.isArray(data)) {
    for (const c of data) {
      if (c && c.name) map[c.name] = c.value;
    }
  } else {
    const knownCookies = new Set(['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','sid','buvid3','buvid4','b_nut','_uuid','b_lsid','bili_ticket','bili_ticket_expires','fingerprint']);
    for (const k of Object.keys(data)) {
      if (typeof data[k] === 'string' && knownCookies.has(k)) {
        map[k] = data[k];
      }
    }
  }

  const sessdata = map.SESSDATA || "";
  const csrf = map.bili_jct || "";
  const mid =
    map.DedeUserID ||
    (data.token_info && data.token_info.mid) ||
    "";
  if (!sessdata) {
    throw new Error("Cookie 中缺少 SESSDATA，请在 B 站页面重新扫码登录");
  }
  const cookie = Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return { cookie, csrf, mid, raw: data };
}

// ---------------------------------------------------------------------------
// 通用 HTTP 请求
// ---------------------------------------------------------------------------

function request(method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(new Error("非法 URL: " + url));
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const headers = Object.assign(
      {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
      },
      opts.headers || {}
    );
    const body = opts.body;
    if (body !== undefined && body !== null) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = lib.request(
      parsed,
      {
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: text,
            json,
          });
        });
      }
    );
    req.setTimeout(opts.timeoutMs || 60000, () => {
      req.destroy(new Error("请求超时: " + method + " " + url));
    });
    req.on("error", reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

function getJson(url, cookie, timeoutMs) {
  return request("GET", url, {
    timeoutMs,
    headers: cookie
      ? {
          Cookie: cookie,
          Referer: "https://member.bilibili.com/",
        }
      : { Referer: "https://member.bilibili.com/" },
  });
}

function postJson(url, body, cookie, extraHeaders = {}) {
  return request("POST", url, {
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        Cookie: cookie,
        Referer: "https://member.bilibili.com/",
      },
      extraHeaders
    ),
    body: JSON.stringify(body),
  });
}

function postForm(url, params, cookie) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.append(k, v === undefined || v === null ? "" : String(v));
  }
  return request("POST", url, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Referer: "https://member.bilibili.com/",
    },
    body: body.toString(),
  });
}

function putChunk(url, buffer, cookie, auth) {
  return request("PUT", url, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Upos-Auth": auth,
      Cookie: cookie,
    },
    body: buffer,
    timeoutMs: 240000,
  });
}

// ---------------------------------------------------------------------------
// UPOS 上传链路
// ---------------------------------------------------------------------------

async function preupload(filePath, cookie, opts = {}) {
  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);
  const upcdn = opts.upcdn || DEFAULT_UPCDN;
  const lineQuery = `zone=cs&upcdn=${encodeURIComponent(upcdn)}&probe_version=20221109`;
  const params = [
    ["name", name],
    ["r", "upos"],
    ["profile", "ugcupos/bup"],
    ["ssl", "0"],
    ["version", DEFAULT_VERSION],
    ["build", String(DEFAULT_BUILD)],
    ["size", String(stat.size)],
  ];
  const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const url = `${preuploadUrl()}?${lineQuery}&${qs}`;

  const res = await getJson(url, cookie);
  if (res.status !== 200) {
    throw new Error(
      "上传预处理失败 HTTP " +
        res.status +
        ": " +
        (res.body || "").slice(0, 500)
    );
  }
  const json = res.json || {};
  if (json.code !== undefined && json.code !== 0 && json.code !== null) {
    throw new Error(
      `上传预处理失败 code=${json.code}: ${json.message || JSON.stringify(json).slice(0, 300)}`
    );
  }
  // biliup 直接解析响应体为 Bucket；部分接口会包一层 data，这里两种都兼容
  const bucket =
    json.data && typeof json.data === "object" ? json.data : json;
  if (!bucket || !bucket.upos_uri || !bucket.auth || !bucket.chunk_size) {
    throw new Error(
      "上传预处理响应缺少必要字段 (upos_uri/auth/chunk_size): " +
        JSON.stringify(json).slice(0, 500)
    );
  }
  return {
    chunkSize: Number(bucket.chunk_size) || 4 * 1024 * 1024,
    auth: bucket.auth,
    endpoint: bucket.endpoint || "",
    endpoints: Array.isArray(bucket.endpoints)
      ? bucket.endpoints.filter((value) => typeof value === "string" && value)
      : [],
    bizId: bucket.biz_id,
    uposUri: bucket.upos_uri,
  };
}

function uposBaseUrl(endpoint) {
  if (!endpoint) return "";
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }
  if (endpoint.startsWith("//")) return "https:" + endpoint;
  return "http://" + endpoint; // 便于本地 mock 测试
}

async function initUploadSession(baseUrl, uposPath, auth) {
  const url = `${baseUrl}/${uposPath}?uploads&output=json`;
  const res = await request("POST", url, {
    headers: {
      "X-Upos-Auth": auth,
      Cookie: "",
    },
    body: "",
    timeoutMs: 60000,
  });
  const json = res.json || {};
  if (!json.upload_id) {
    throw new Error(
      "初始化上传会话失败: " + (res.body || res.status).toString().slice(0, 300)
    );
  }
  return json.upload_id;
}

async function uploadChunkWithRetry(url, buffer, auth, attempts) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await putChunk(url, buffer, "", auth);
      if (res.status >= 200 && res.status < 300) return res;
      lastErr = new Error(
        `分片上传 HTTP ${res.status}: ${(res.body || "").slice(0, 300)}`
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("分片上传失败");
}

/**
 * 上传单个视频文件到 B 站 UPOS。
 * 返回 { filename, bizId, uposUri, uploadId }，其中 filename 用于投稿 videos 数组。
 */
async function uploadFileToUpos({
  filePath,
  cookie,
  onProgress,
  // Called immediately before each UPOS part. It may await a bandwidth gate;
  // this intentionally keeps the same uploadId and completed parts in memory.
  beforeChunk,
  upcdn,
  endpointOverride,
  uposUriOverride,
}) {
  const bucket = await preupload(filePath, cookie, { upcdn });
  const uposUri = uposUriOverride || bucket.uposUri;
  const endpointCandidates = endpointOverride
    ? [endpointOverride]
    : [...new Set([bucket.endpoint, ...(bucket.endpoints || [])].filter(Boolean))];
  if (!endpointCandidates.length || !uposUri) {
    throw new Error("上传预处理未返回可用的 endpoint/upos_uri");
  }
  const uposPath = uposUri.replace(/^upos:\/\//, "");
  let baseUrl = "";
  let uploadId = "";
  let lastInitError = null;
  for (const endpoint of endpointCandidates) {
    baseUrl = uposBaseUrl(endpoint);
    if (!baseUrl) continue;
    try {
      uploadId = await initUploadSession(baseUrl, uposPath, bucket.auth);
      break;
    } catch (err) {
      lastInitError = err;
    }
  }
  if (!uploadId) throw lastInitError || new Error("初始化上传会话失败");

  const totalSize = fs.statSync(filePath).size;
  const chunkSize = bucket.chunkSize;
  const chunks = Math.max(1, Math.ceil(totalSize / chunkSize));
  const fd = fs.openSync(filePath, "r");
  const parts = [];
  let uploadedBytes = 0;
  try {
    for (let i = 0; i < chunks; i++) {
      if (typeof beforeChunk === "function") await beforeChunk({ chunk: i, chunks, uploadedBytes, totalSize });
      const start = i * chunkSize;
      const len = Math.min(chunkSize, totalSize - start);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const params = new URLSearchParams({
        uploadId,
        chunks: String(chunks),
        total: String(totalSize),
        chunk: String(i),
        size: String(len),
        partNumber: String(i + 1),
        start: String(start),
        end: String(start + len),
      });
      const url = `${baseUrl}/${uposPath}?${params.toString()}`;
      await uploadChunkWithRetry(url, buf, bucket.auth, MAX_CHUNK_RETRY);
      parts.push({ partNumber: i + 1, eTag: "etag" });
      uploadedBytes += len;
      if (typeof onProgress === "function") {
        try {
          onProgress(uploadedBytes / totalSize);
        } catch {}
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // 合片并获取视频信息
  const finalizeQs = new URLSearchParams({
    name: path.basename(filePath),
    uploadId,
    biz_id: String(bucket.bizId || ""),
    output: "json",
    profile: "ugcupos/bup",
  });
  const finalizeUrl = `${baseUrl}/${uposPath}?${finalizeQs.toString()}`;
  const finRes = await postJson(finalizeUrl, { parts }, "", {
    "X-Upos-Auth": bucket.auth,
  });
  const finJson = finRes.json || {};
  if (finJson.OK !== 1) {
    throw new Error(
      "视频合片失败: " + (finRes.body || finRes.status).toString().slice(0, 400)
    );
  }

  const stem = path.basename(uposUri).replace(/\.[^.]+$/, "");
  const filename = stem.length > 80 ? stem.slice(0, 77) + "..." : stem;
  return {
    filename,
    bizId: bucket.bizId,
    uposUri,
    uploadId,
  };
}

// ---------------------------------------------------------------------------
// 投稿 payload / 草稿 / 发布
// ---------------------------------------------------------------------------

function buildArchivePayload(meta, video, csrf, opts = {}) {
  const { forPublish } = opts;
  const payload = {
    videos: [
      {
        filename: video.filename,
        title: meta.partTitle || meta.title || "",
        desc: meta.partDesc || "",
        cid: video.bizId || 0,
      },
    ],
    cover: meta.cover || "",
    title: meta.title || "",
    copyright: meta.copyright || 1,
    tid: meta.tid || 171,
    tag: meta.tag || "",
    desc_format_id: 9999,
    desc: meta.desc || "",
    source: meta.source || "",
    recreate: -1,
    dynamic: meta.dynamic || "",
    interactive: 0,
    act_reserve_create: 0,
    no_disturbance: 0,
    no_reprint: meta.no_reprint || 0,
    subtitle: { open: 0, lan: "" },
    dolby: 0,
    lossless_music: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    csrf,
  };
  if (forPublish) payload.web_os = 3;
  return payload;
}

function parseDraftId(json) {
  const d = json && json.data;
  if (d && typeof d === "object") {
    if (d.draft_id !== undefined) return d.draft_id;
    if (d.id !== undefined) return d.id;
  }
  if (typeof d === "number") return d;
  if (typeof d === "string" && /^[1-9]\d{0,15}$/.test(d) && Number.isSafeInteger(Number(d))) return d;
  return null;
}

function biliError(label, json) {
  const code = json && json.code !== undefined ? json.code : "unavailable";
  const message = json && typeof json.message === "string"
    ? json.message.slice(0, 200)
    : "Bilibili upstream is unavailable";
  return new Error(
    `${label}失败 code=${code}: ${message}`
  );
}

function safeDraftCover(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    const raw = value.trim().slice(0, 2048);
    parsed = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return "";
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") return "";
  const hostname = parsed.hostname.toLowerCase();
  if (![".hdslb.com", ".biliimg.com", ".bilibili.com"].some((suffix) => hostname.endsWith(suffix))) return "";
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function isoFromUnix(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 1e12 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDraftItem(item) {
  const draftId = item && (item.draft_id !== undefined ? item.draft_id : item.id);
  const created = item && (item.ctime !== undefined ? item.ctime : item.created);
  const modified = item && (item.mtime !== undefined ? item.mtime : item.modified);
  const videos = item && Array.isArray(item.videos) ? item.videos : null;
  const videoCount = safeInteger(item && (item.video_count !== undefined ? item.video_count : item.videoCount));
  return {
    draftId: draftId === undefined || draftId === null ? "" : String(draftId).slice(0, 80),
    title: typeof (item && item.title) === "string" ? item.title.slice(0, 200) : "",
    cover: safeDraftCover(item && item.cover),
    summary: typeof (item && item.summary) === "string" ? item.summary.slice(0, 500) : "",
    status: safeInteger(item && item.status),
    ctime: safeInteger(created),
    mtime: safeInteger(modified),
    createdAt: isoFromUnix(created),
    updatedAt: isoFromUnix(modified),
    videoCount: videos ? videos.length : videoCount,
    videoCid: safeInteger(item && item.cid),
  };
}

/**
 * 保存草稿。format: "json" | "form" | "auto"（json 失败后自动退回表单）。
 * 返回 { draftId, raw }。
 */
async function saveDraft({ meta, video, cookie, csrf, format }) {
  const ts = Date.now();
  const url = `${draftUrl()}?ts=${ts}&csrf=${encodeURIComponent(csrf)}`;
  const jsonBody = buildArchivePayload(meta, video, csrf, { forPublish: false });
  const mode = format || "auto";

  let res;
  if (mode === "form") {
    res = await tryFormDraft(url, jsonBody, cookie, csrf);
  } else {
    res = await postJson(url, jsonBody, cookie);
    if (
      mode === "auto" &&
      (!res.json || (res.json.code !== undefined && res.json.code !== 0))
    ) {
      const fallback = await tryFormDraft(url, jsonBody, cookie, csrf);
      if (fallback) res = fallback;
    }
  }
  const json = res.json;
  if (!json || json.code !== 0) {
    throw biliError("保存草稿", json);
  }
  let draftId = parseDraftId(json);
  if (!draftId && Number(video.bizId) > 0) {
    try {
      const matches = (await listDrafts({ cookie, pn: 1, ps: 100 })).filter(item => item.videoCid === Number(video.bizId));
      if (matches.length === 1) draftId = matches[0].draftId;
    } catch { /* Saving succeeded; never retry creation just because lookup failed. */ }
  }
  return { draftId, raw: json };
}

async function publishArchive({ meta, video, cookie, csrf }) {
  const payload = buildArchivePayload(meta, video, csrf, { forPublish: true });
  const ts = Date.now();
  const url = `${addUrl()}?ts=${ts}&csrf=${encodeURIComponent(csrf)}`;
  const res = await postJson(url, payload, cookie);
  const json = res.json;
  if (!json || json.code !== 0) throw biliError("发布投稿", json);
  return {
    aid: json.data && json.data.aid,
    bvid: json.data && json.data.bvid,
    raw: json,
  };
}

async function tryFormDraft(url, jsonBody, cookie, csrf) {
  const form = {
    csrf,
    copyright: jsonBody.copyright,
    title: jsonBody.title,
    tid: jsonBody.tid,
    tag: jsonBody.tag,
    desc_format_id: jsonBody.desc_format_id,
    desc: jsonBody.desc,
    cover: jsonBody.cover,
    dynamic: jsonBody.dynamic,
    recreate: -1,
    interactive: 0,
    no_reprint: jsonBody.no_reprint,
    videos: JSON.stringify(jsonBody.videos),
  };
  return postForm(url, form, cookie);
}

async function listDrafts({ cookie, pn, ps, timeoutMs }) {
  const qs = new URLSearchParams({
    pn: String(pn || 1),
    ps: String(ps || 20),
  });
  const res = await getJson(`${draftListUrl()}?${qs.toString()}`, cookie, timeoutMs);
  const json = res.json;
  if (!json || json.code !== 0) {
    throw biliError("获取草稿列表", json);
  }
  const data = json.data || {};
  const list = Array.isArray(data)
    ? data
    : (Array.isArray(data.list) ? data.list : data.drafts);
  if (!Array.isArray(list)) {
    throw new Error("获取草稿列表失败: Bilibili returned an unexpected response shape");
  }
  return list.map(normalizeDraftItem);
}

function validateDraftId(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    const error = new Error("无效的草稿 ID");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function deleteDraft({ cookie, csrf, draftId }) {
  const id = validateDraftId(draftId);
  if (!cookie || !csrf) {
    const error = new Error("B站登录凭据不完整，请重新扫码登录");
    error.statusCode = 401;
    throw error;
  }
  // Resolve only drafts belonging to the currently logged-in account. Never use
  // an archive aid/cid, a card index, or a title as a deletion identifier.
  let drafts;
  try { drafts = await listDrafts({ cookie, pn: 1, ps: 100, timeoutMs: 10_000 }); }
  catch { throw new Error("无法核实 B站草稿列表，未执行删除，请刷新后重试"); }
  if (!drafts.some((item) => item.draftId === id)) {
    const error = new Error("该草稿已不存在或不属于当前账号，请刷新列表");
    error.statusCode = 404;
    throw error;
  }
  // Contract verified in Bilibili's creativecenter-v3 index + 5421 bundles:
  // delDraft({ id }) -> POST /x/vupre/web/draft/delete (form + bili_jct).
  let response;
  try {
    response = await request("POST", process.env.BILI_DRAFT_DELETE_URL || "https://member.bilibili.com/x/vupre/web/draft/delete", {
      headers: { Cookie: cookie, Referer: "https://member.bilibili.com/", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id, csrf, csrf_token: csrf }).toString(),
      timeoutMs: 10_000,
    });
  } catch {
    throw new Error("未收到 B站删除结果，请先刷新草稿列表确认；系统不会自动重试删除");
  }
  if (response.status !== 200 || response.json?.code !== 0) {
    throw new Error("B站未确认删除成功，请刷新列表或重新登录后检查");
  }
  return { draftId: id, deleted: true, recordingPreserved: true };
}

async function viewDraft({ cookie, draftId }) {
  const qs = new URLSearchParams({ id: String(draftId) });
  const res = await getJson(`${draftViewUrl()}?${qs.toString()}`, cookie);
  const json = res.json;
  if (!json || json.code !== 0) {
    throw biliError("获取草稿详情", json);
  }
  return json.data;
}

function mapDraftToPublishPayload(draftData, csrf) {
  const d = draftData && draftData.raw !== undefined ? draftData.raw : draftData;
  const videos = Array.isArray(d.videos)
    ? d.videos.map((v) => ({
        filename: v.filename || "",
        title: v.title || "",
        desc: v.desc || "",
        cid: v.cid || v.biz_id || 0,
      }))
    : [];
  const payload = {
    videos,
    cover: d.cover || "",
    title: d.title || "",
    copyright: d.copyright || 1,
    tid: d.tid || 171,
    tag: d.tag || "",
    desc_format_id: d.desc_format_id || 0,
    desc: d.desc || "",
    source: d.source || "",
    recreate: d.recreate !== undefined ? d.recreate : -1,
    dynamic: d.dynamic || "",
    interactive: d.interactive || 0,
    act_reserve_create: d.act_reserve_create || 0,
    no_disturbance: d.no_disturbance || 0,
    no_reprint: d.no_reprint || 0,
    dolby: d.dolby || 0,
    lossless_music: d.lossless_music || 0,
    up_selection_reply: !!d.up_selection_reply,
    up_close_reply: !!d.up_close_reply,
    up_close_danmu: !!d.up_close_danmu,
    web_os: 3,
    csrf,
  };
  return payload;
}

async function publishDraft({ cookie, csrf, draftId }) {
  const draftData = await viewDraft({ cookie, draftId });
  const payload = mapDraftToPublishPayload(draftData, csrf);
  if (!payload.videos.length) {
    throw new Error("草稿中没有视频分P，无法发布");
  }
  const ts = Date.now();
  const url = `${addUrl()}?ts=${ts}&csrf=${encodeURIComponent(csrf)}`;
  const res = await postJson(url, payload, cookie);
  const json = res.json;
  if (!json || json.code !== 0) {
    throw biliError("发布草稿", json);
  }
  return {
    aid: json.data && json.data.aid,
    bvid: json.data && json.data.bvid,
    raw: json,
  };
}

async function uploadCover({ filePath, cookie, csrf }) {
  const result = await postForm(process.env.BILI_COVER_URL || "https://member.bilibili.com/x/vu/web/cover/up", {
    cover: `data:image/jpeg;base64,${fs.readFileSync(filePath).toString("base64")}`, csrf,
  }, cookie);
  if (result.status !== 200 || result.json?.code !== 0 || !safeDraftCover(result.json?.data?.url)) {
    throw new Error("B站封面上传失败: " + (result.json?.message || result.status));
  }
  return safeDraftCover(result.json.data.url);
}

async function updateDraftCover({ draftId, cover, cookie, csrf, beforeWrite }) {
  const id = validateDraftId(String(draftId));
  if (!cookie || !csrf || !safeDraftCover(cover)) throw new Error("B站登录凭据或封面不完整");
  const detail = await viewDraft({ cookie, draftId: id });
  let raw = detail?.raw ?? detail;
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (!raw || !Array.isArray(raw.videos) || !raw.videos.length || raw.videos.some(v => !v.filename)) throw new Error("无法核实草稿视频信息，未修改 B站封面");
  if (detail?.id != null && String(detail.id) !== id) throw new Error("草稿 ID 不一致，未修改 B站封面");
  await beforeWrite?.(detail);
  // Use the draft update endpoint; never create or publish a replacement draft.
  const result = await postJson(`${process.env.BILI_DRAFT_UPDATE_URL || "https://member.bilibili.com/x/vupre/web/draft/update"}?csrf=${encodeURIComponent(csrf)}`, { ...raw, id: Number(id), cover: safeDraftCover(cover), csrf }, cookie);
  if (result.status !== 200 || result.json?.code !== 0) throw biliError("同步草稿封面", result.json);
  const checked = await viewDraft({ cookie, draftId: id });
  let checkedRaw = checked?.raw ?? checked;
  if (typeof checkedRaw === "string") checkedRaw = JSON.parse(checkedRaw);
  if (safeDraftCover(checkedRaw?.cover) !== safeDraftCover(cover)) throw new Error("B站尚未返回新封面，请刷新后检查；系统未自动重试");
  return { draftId: id, cover: safeDraftCover(cover), verified: true };
}

module.exports = {
  uploadCover,
  updateDraftCover,
  loadCredentials,
  uploadFileToUpos,
  saveDraft,
  publishArchive,
  listDrafts,
  deleteDraft,
  validateDraftId,
  viewDraft,
  publishDraft,
  buildArchivePayload,
  mapDraftToPublishPayload,
  // 导出内部函数便于测试
  _internals: {
    request,
    preupload,
    parseDraftId,
    normalizeDraftItem,
  },
};
