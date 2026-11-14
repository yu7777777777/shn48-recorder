"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const HOME = process.env.HOME || process.env.USERPROFILE || "/root";
// Keep this credential alongside the rest of the service's persisted state.
// `POCKET48_DATA_DIR` remains available for installations which use a separate
// secret volume.
const DATA_DIR = process.env.POCKET48_DATA_DIR || process.env.DATA_DIR || path.join(HOME, ".shn48-data");
const TOKEN_PATH = path.join(DATA_DIR, "pocket48-token.json");

// Pocket48 API client - direct HTTP wrapper
const BASE_URL = process.env.POCKET48_BASE || "pocketapi.48.cn";
const UA = "PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)";
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.POCKET48_TIMEOUT_MS) || 12000);
const LIVE_ONE_PATH = "/live/api/v1/live/getLiveOne";
const LOGIN_APP_VERSION = "7.0.41";
const LOGIN_APP_BUILD = "24011601";
const PA_POST_KEY = "ejrw9u345h32u@#&%^#G";
const PA_VERSION = "2021060901";

let _token = null;

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      // Accept the legacy shape once so an existing deployment does not lose
      // its login; the next successful login/save upgrades it atomically.
      const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      _token = validateStoredToken({ ...raw, version: raw.version || 1 });
    }
  } catch { _token = null; }
  return _token;
}

function validateStoredToken(value) {
  if (!value || value.version !== 1 || typeof value.token !== "string" || !value.token || value.token.length > 4096) return null;
  if (/[\x00-\x20\x7f]/.test(value.token)) return null;
  return {
    version: 1,
    token: value.token,
    userId: value.userId === undefined || value.userId === null ? undefined : String(value.userId),
    nickname: typeof value.nickname === "string" ? value.nickname.slice(0, 128) : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function persistToken(token) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(DATA_DIR, `.${path.basename(TOKEN_PATH)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(token, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporaryPath, TOKEN_PATH);
    fs.chmodSync(TOKEN_PATH, 0o600);
  } catch (error) {
    if (handle !== undefined && handle !== null) try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function saveToken(token) {
  const normalized = validateStoredToken({ ...token, version: 1, updatedAt: new Date().toISOString() });
  if (!normalized) throw new Error("Invalid Pocket48 access token");
  persistToken(normalized);
  _token = normalized;
  return publicTokenInfo(normalized);
}

function getToken() { return _token || loadToken(); }

function clearToken() {
  _token = null;
  try { if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH); } catch {}
}

function publicTokenInfo(token = getToken()) {
  if (!token) return null;
  return {
    authenticated: true,
    account: {
      ...(token.userId ? { userId: token.userId } : {}),
      ...(token.nickname ? { nickname: token.nickname } : {}),
    },
    ...(token.updatedAt ? { updatedAt: token.updatedAt } : {}),
  };
}

function authStatus(token, state, extra = {}) {
  if (!token) {
    return {
      authenticated: false,
      credentialsPresent: false,
      health: "not_logged_in",
      upstreamAvailable: null,
    };
  }
  return {
    ...publicTokenInfo(token),
    authenticated: state === "ok",
    credentialsPresent: true,
    health: state,
    ...extra,
  };
}

// A saved token is not proof that the Pocket48 session is still accepted.  The
// admin UI uses this small authenticated request to distinguish a valid session
// from an expired/revoked one, while deliberately keeping the token private.
async function getAuthStatus() {
  const token = getToken();
  if (!token) return authStatus(null, "not_logged_in");
  try {
    const result = await pocket48Request(
      "POST",
      "/user/api/v1/user/info/reload",
      { from: "appstart" },
      undefined,
      { accessToken: token.token }
    );
    const content = result && result.data && result.data.content;
    if (result && result.status >= 200 && result.status < 300 && result.data?.status === 200 && content) {
      return authStatus(token, "ok", { upstreamAvailable: true });
    }
    return authStatus(token, "invalid", { upstreamAvailable: true });
  } catch {
    // A network outage must not be presented as an expired session.
    return authStatus(token, "unavailable", { upstreamAvailable: false });
  }
}

function md5(str) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(str).digest("hex");
}

function randomHex(length) {
  return require("crypto").randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length).toUpperCase();
}

function createAppInfo() {
  return JSON.stringify({
    vendor: "apple",
    deviceId: `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`,
    appVersion: "7.0.4",
    appBuild: "23011601",
    osVersion: "16.3.1",
    osType: "ios",
    deviceName: "iPhone XR",
    os: "ios",
  });
}

function requestHeaders(extraHeaders) {
  return {
    "Content-Type": "application/json;charset=utf-8",
    Accept: "application/json",
    "Accept-Language": "zh-Hans-AW;q=1",
    "User-Agent": UA,
    appInfo: createAppInfo(),
    ...(extraHeaders || {}),
  };
}

// Pocket48's login endpoints reject otherwise valid JSON requests unless the
// short-lived `pa` header is present. This is an independent implementation of
// the current wire format; it intentionally has no dependency on app binaries.
function createPa({ now = Date.now(), uuid = crypto.randomUUID() } = {}) {
  const timestamp = String(Math.trunc(Number(now)));
  const nonce = String(uuid).replace(/-/g, "").toLowerCase();
  if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new Error("Unable to create Pocket48 request signature");
  }
  const signature = crypto.createHash("md5").update(`${timestamp}${nonce}${PA_POST_KEY}`, "utf8").digest("hex");
  return Buffer.from(`${timestamp}${nonce}${signature}${PA_VERSION}`, "utf8").toString("base64");
}

function loginRequestHeaders() {
  const appInfo = JSON.stringify({
    vendor: "apple",
    deviceId: `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`,
    appVersion: LOGIN_APP_VERSION,
    appBuild: LOGIN_APP_BUILD,
    osVersion: "16.3.1",
    osType: "ios",
    deviceName: "iPhone XR",
    os: "ios",
  });
  return requestHeaders({
    pa: createPa(),
    appInfo,
    "User-Agent": `PocketFans201807/${LOGIN_APP_VERSION} (iPhone; iOS 16.3.1; Scale/2.00)`,
    "Accept-Language": "zh-Hans-CN;q=1",
  });
}

function pocket48Request(method, apiPath, body, extraHeaders, options = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const token = options.anonymous ? null : (options.accessToken ? { token: options.accessToken } : getToken());
    const headers = options.signed || (token && token.token) ? loginRequestHeaders() : requestHeaders(extraHeaders);
    if (extraHeaders) Object.assign(headers, extraHeaders);
    headers["Content-Length"] = Buffer.byteLength(postData);
    if (token && token.token) headers.token = token.token;

    const req = https.request(
      {
        hostname: BASE_URL,
        path: apiPath,
        method,
        headers,
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(b) });
          } catch {
            resolve({ status: res.statusCode, data: b, raw: true });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(postData);
    req.end();
  });
}

// ---- Login ----
async function login(mobile, password) {
  const body = { mobile, areaCode: "86", pwd: md5(password) };
  const result = await pocket48Request("POST", "/user/api/v1/login/app/mobile", body, undefined, { anonymous: true, signed: true });
  return saveLoginResponse(result);
}

function saveLoginResponse(result) {
  const json = result && result.data;
  const content = json && json.content;
  const token = content && content.token;
  if (!json || json.status !== 200 || typeof token !== "string" || !token) {
    return { success: false, error: "Pocket48 rejected the login request" };
  }
  const userInfo = content.userInfo || content;
  return {
    success: true,
    data: saveToken({
      token,
      userId: userInfo.userId || userInfo.id,
      nickname: userInfo.nickname || userInfo.name,
    }),
  };
}

function normalizeVerificationChallenge(message) {
  let value = message;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const question = typeof value.question === "string" ? value.question.trim().slice(0, 200) : "";
  const rawOptions = Array.isArray(value.answer) ? value.answer : Array.isArray(value.options) ? value.options : [];
  const options = rawOptions.slice(0, 8).map((option) => {
    if (typeof option === "string" || typeof option === "number") {
      const text = String(option).trim().slice(0, 128);
      return text ? { label: text, value: text } : null;
    }
    if (!option || typeof option !== "object") return null;
    const rawValue = option.value ?? option.answer ?? option.id ?? option.text ?? option.label;
    const rawLabel = option.label ?? option.text ?? option.name ?? rawValue;
    const normalizedValue = String(rawValue ?? "").trim().slice(0, 128);
    const normalizedLabel = String(rawLabel ?? "").trim().slice(0, 128);
    return normalizedValue && normalizedLabel ? { label: normalizedLabel, value: normalizedValue } : null;
  }).filter(Boolean);
  return question && options.length ? { question, options } : null;
}

async function sendSmsCode(mobile, answer) {
  const body = { mobile, area: "86", ...(answer ? { answer } : {}) };
  const result = await pocket48Request("POST", "/user/api/v1/sms/send2", body, undefined, { anonymous: true, signed: true });
  const json = result && result.data;
  if (result && result.status === 200 && json && json.status === 200) return { success: true };
  if (json && json.status === 2001) {
    const challenge = normalizeVerificationChallenge(json.message || json.content);
    if (challenge) return { success: false, reason: "verification_required", challenge };
  }
  return { success: false, reason: "rejected" };
}

async function loginWithCode(mobile, code) {
  const result = await pocket48Request(
    "POST",
    "/user/api/v1/login/app/mobile/code",
    { mobile, code },
    undefined,
    { anonymous: true, signed: true }
  );
  return saveLoginResponse(result);
}

async function saveAccessToken(accessToken) {
  const candidate = validateStoredToken({ version: 1, token: accessToken });
  if (!candidate) return { success: false, error: "Invalid Pocket48 access token" };
  // Verify before persisting.  Do not replace a working saved credential with
  // arbitrary pasted text, and never include the candidate in an error/log.
  const result = await pocket48Request("POST", "/user/api/v1/user/info/reload", { from: "appstart" }, undefined, { accessToken: candidate.token });
  const content = result && result.data && result.data.content;
  if (!result || !result.data || result.data.status !== 200 || !content) {
    return { success: false, error: "Pocket48 rejected this access token" };
  }
  const userInfo = content.userInfo || content;
  return {
    success: true,
    data: saveToken({
      token: candidate.token,
      userId: userInfo.userId || userInfo.id,
      nickname: userInfo.nickname || userInfo.name,
    }),
  };
}

async function switchLinkedAccount(toUserId, expectedToken) {
  if (!expectedToken || getToken()?.token !== expectedToken) throw new Error('Account changed');
  const result = await pocket48Request('POST', '/user/api/v1/bigsmall/switch/user', { toUserId: String(toUserId) }, undefined, { accessToken: expectedToken });
  const data = result?.data?.content;
  const user = data?.userInfo || data;
  if (result?.status !== 200 || result?.data?.status !== 200 || !data?.token || String(user?.userId || user?.id) !== String(toUserId)) throw new Error('Switch rejected');
  if (getToken()?.token !== expectedToken) throw new Error('Account changed');
  return saveToken({ token: data.token, userId: user.userId || user.id, nickname: user.nickname || user.name });
}

// ---- Room Messages ----
let roomCache = { token: null, until: 0, rooms: [] };
const roomDirectory = require('./room-directory');
async function getRoomList() {
  const token = getToken()?.token;
  const result = await pocket48Request("POST", "/im/api/v1/conversation/page", { nextTime: 0, limit: 100 });
  if (result.status === 200 && result.data?.status === 200) {
    const rows = result.data.content?.conversations;
    if (!Array.isArray(rows)) throw new Error('Invalid conversation response');
    const rooms = rows.filter(r => Number(r.targetType) === 0 && r.targetId && r.ownerId).map(r => ({ roomId: String(r.targetId), roomName: r.targetName || r.ownerName || '', ownerId: String(r.ownerId), ownerName: r.ownerName || '' }));
    await Promise.all(rooms.map(async room => {
      try { room.teamName = (await roomDirectory.resolve(room.roomId, room.ownerId))?.teamName || ''; }
      catch { room.teamName = ''; }
    }));
    roomCache = { token, until: Date.now() + 30000, rooms };
    return { ...result, data: { ...result.data, content: { rooms } } };
  }
  return result;
}
async function getRoomInfo(roomId) {
  return pocket48Request('POST', '/im/api/v1/im/team/room/info', { channelId: String(roomId) });
}
// A member's room can be read from two different Pocket48 streams, and which one
// answers depends on the member, not on us:
//   * QChat channel stream (team/message/list/*) — needs a channelId from the
//     public directory. Answers "频道不存在" (200 over the wire, 500 in the body)
//     for members whose channel is gone (measured: 33 of the first 80).
//   * Legacy IM room stream (chatroom/msg/list/*) — keyed by the conversation
//     room id, which the directory does not carry.
// The channel stream also proves it is a superset: every message it returns is
// tagged module=QCHAT and it already carries LIVEPUSH (live notifications), so
// "仅成员" needs no second request at all — it is the channel transcript without
// fan chatter. The notification endpoint stays as a fallback for the older path
// where a caller passes a conversation id straight from the room list.
function messageRows(result) {
  const c = (result && result.data && result.data.content) || {};
  return Array.isArray(c.message) ? c.message : Array.isArray(c.messages) ? c.messages : Array.isArray(c.list) ? c.list : [];
}
async function conversationRoom(roomId) {
  const direct = roomCache.rooms.find(r => r.roomId === String(roomId));
  if (direct) return direct;
  let ownerId = null;
  try { ownerId = (await roomDirectory.resolve(roomId))?.ownerId || null; } catch { ownerId = null; }
  return ownerId ? roomCache.rooms.find(r => r.ownerId === String(ownerId)) || null : null;
}
async function getRoomMessages(roomId, nextTime, scope = 'members') {
  if (!['members', 'all', 'notifications'].includes(scope)) throw Object.assign(new Error('消息类型无效'), { status: 400 });
  const token = getToken()?.token;
  if (roomCache.token !== token || roomCache.until < Date.now()) {
    const result = await getRoomList();
    if (result.status !== 200 || result.data?.status !== 200) return result;
  }
  const room = roomCache.rooms.find(r => r.roomId === String(roomId));
  if (scope !== 'notifications') {
    let channel;
    try { channel = await roomDirectory.resolve(roomId, room?.ownerId); }
    catch { throw Object.assign(new Error('成员频道索引暂时不可用，请稍后重试'), { status: 502 }); }
    if (!channel && !room) {
      const info = await getRoomInfo(roomId);
      if (info.status === 200 && info.data?.status === 200 && info.data?.content?.serverId) {
        channel = { channelId: String(roomId), serverId: String(info.data.content.serverId) };
      }
    }
    if (channel) {
      const result = await pocket48Request('POST', '/im/api/v1/team/message/list/' + (scope === 'all' ? 'all' : 'homeowner'), {
        channelId: channel.channelId, serverId: channel.serverId, nextTime: String(nextTime || 0), limit: 50
      });
      const answered = result?.status === 200 && result?.data?.status === 200;
      // 仅成员 is the channel transcript minus fan chatter. It already carries
      // LIVEPUSH, so a QUIET channel is a complete answer and must be returned as
      // is — falling through on emptiness turned a quiet member into 0 rows while
      // 全部 showed 22 (measured on 刘增艳). Only a channel that did not answer
      // (body status 500 "频道不存在") falls through to the room stream.
      if (scope === 'all' || answered) return result;
      if (!room && !(await conversationRoom(roomId))) return result;
    }
  }
  const target = await conversationRoom(roomId);
  if (!target) {
    if (scope === 'notifications') throw Object.assign(new Error('该成员的直播通知房间未开通，没有可读的通知消息'), { status: 404 });
    throw Object.assign(new Error('未找到该成员的聊天频道，暂时无法读取成员和粉丝消息'), { status: 502 });
  }
  // homeowner = the member's own live/翻牌 stream; all = the fan room. Both the
  // 仅成员 fallback and 直播通知 want the member's own stream.
  return pocket48Request('POST', '/im/api/v1/chatroom/msg/list/' + (scope === 'all' ? 'all' : 'homeowner'), {
    roomId: target.roomId, ownerId: target.ownerId, nextTime: String(nextTime || 0), needTop1Msg: 'false'
  });
}
// Room diagnosis: ask every known message endpoint the same question and report
// which ones actually answered with rows. Read-only; used by the admin console
// when a room shows nothing, to separate "no messages" from "endpoint is gone".
const rowCount = result => messageRows(result).length;
async function probeRoomMessages(roomId, nextTime) {
  const room = roomCache.rooms.find(r => r.roomId === String(roomId));
  let channel = null, directoryError = '';
  try { channel = await roomDirectory.resolve(roomId, room?.ownerId); }
  catch (e) { directoryError = e.message; }
  const sources = [];
  if (channel) sources.push({ source: 'channel', run: () => pocket48Request('POST', '/im/api/v1/team/message/list/all', { channelId: channel.channelId, serverId: channel.serverId, nextTime: String(nextTime || 0), limit: 50 }) });
  const target = await conversationRoom(roomId);
  if (target) sources.push({ source: 'room', run: () => pocket48Request('POST', '/im/api/v1/chatroom/msg/list/all', { roomId: target.roomId, ownerId: target.ownerId, nextTime: String(nextTime || 0) }) });
  const results = await Promise.allSettled(sources.map(s => s.run()));
  const report = sources.map((s, i) => {
    const r = results[i];
    if (r.status === 'rejected') return { source: s.source, ok: false, error: r.reason?.message || String(r.reason) };
    return { source: s.source, ok: r.value?.status === 200 && r.value?.data?.status === 200, http: r.value?.status, code: r.value?.data?.status, rows: rowCount(r.value) };
  });
  return { roomId: String(roomId), channel: Boolean(channel), conversation: Boolean(target), directoryError, report };
}
async function getLiveDanmakuMessages(roomId, nextTime) {
  return pocket48Request('POST', '/im/api/v1/chatroom/msg/list/all', {
    roomId: String(roomId), ...(nextTime ? { nextTime: String(nextTime) } : {})
  });
}
async function getAllRoomMessages(roomId, nextTime) {
  return getRoomMessages(roomId, nextTime, 'all');
}

// ---- Member Info ----
async function getMemberInfo(memberId) {
  return pocket48Request("POST", "/user/api/v1/member/info", { memberId: String(memberId) });
}
async function getStarList(groupId, page) {
  return pocket48Request("POST", "/user/api/v1/member/star/list", {
    groupId: String(groupId || 0),
    page: page || 0,
  });
}
// Official directory endpoint. `member/star/list` is a user-specific favourites
// endpoint and must not be used as the roster shown by automatic recording.
async function getMemberList(groupId, page) {
  return pocket48Request("POST", "/user/api/v1/member/list", {
    groupId: String(groupId || 0),
    page: Number(page) || 0,
  });
}
async function getGroupList() {
  return pocket48Request("POST", "/user/api/v1/group/list", {});
}

// ---- Friendships (真正的口袋48 关注/取关) ----
//
// These write to the logged-in Pocket48 account itself. They are the ONLY
// follow/unfollow mechanism in this project: the local "monitor" room watch
// list is unrelated and does not touch the account.
//
// `toSourceId` is the member's `ownerId`, which is the same value the roster
// exposes as `id` and the room list exposes as `ownerId`. `toType: 1` means
// "member", and is required — omitting it returns "缺少请求参数".
async function getFollowedIds() {
  return pocket48Request("POST", "/user/api/v1/friendships/friends/id", {});
}
async function followMember(ownerId) {
  return pocket48Request("POST", "/user/api/v2/friendships/friends/add", {
    toSourceId: Number(ownerId),
    toType: 1,
  });
}
async function unfollowMember(ownerId) {
  return pocket48Request("POST", "/user/api/v2/friendships/friends/remove", {
    toSourceId: Number(ownerId),
    toType: 1,
  });
}

// ---- Check-in ----
async function getCheckinInfo() {
  return pocket48Request("POST", "/user/api/v1/checkin/check/today", {});
}
async function doCheckin() {
  return pocket48Request("POST", "/user/api/v1/checkin", {});
}

// ---- Live ----
async function getLiveList(groupId, next) {
  return pocket48Request("POST", "/live/api/v1/live/getLiveList", {
    groupId: String(groupId || 0),
    debug: false,
    next: String(next || "0"),
    record: false,
  }, undefined, { anonymous: true });
}
async function getOneLive(liveId) {
  return pocket48Request("POST", LIVE_ONE_PATH, { liveId: String(liveId) }, undefined, { anonymous: true });
}

function replayListBody({ next = "0", groupId, userId } = {}) {
  const body = {
    debug: true,
    next: String(next || "0"),
    record: true,
  };
  if (userId !== undefined && userId !== null && userId !== "") body.userId = String(userId);
  else if (groupId !== undefined && groupId !== null && groupId !== "") body.groupId = String(groupId);
  return body;
}

// Official Pocket48 replay metadata is public upstream. Keep these requests
// deliberately anonymous so a configured private Pocket48 token is never sent
// on behalf of a public visitor.
async function getReplayListPage(options = {}) {
  return pocket48Request(
    "POST",
    "/live/api/v1/live/getLiveList",
    replayListBody(options),
    undefined,
    { anonymous: true }
  );
}

async function getReplayOne(liveId) {
  return pocket48Request(
    "POST",
    LIVE_ONE_PATH,
    { liveId: String(liveId) },
    undefined,
    { anonymous: true }
  );
}

// ---- User Info ----
async function getUserInfo() {
  return pocket48Request("POST", "/user/api/v1/user/info/reload", { from: "appstart" });
}

// ---- News / Moments ----
async function getNewsList(next) {
  return pocket48Request("POST", "/user/api/v1/news/list", { next: String(next || "0") });
}

async function getRoomVoice(roomId, ownerId) {
  const channel = await roomDirectory.resolve(String(roomId), ownerId);
  if (!channel) throw new Error('未找到成员语音频道');
  return pocket48Request('POST', '/im/api/v1/team/voice/operate', {
    channelId: Number(channel.channelId), serverId: Number(channel.serverId), operateCode: 2
  });
}

module.exports = {
  getRoomVoice,
  login, sendSmsCode, loginWithCode, saveAccessToken, switchLinkedAccount, getToken, clearToken, publicTokenInfo, getAuthStatus,
  getRoomMessages, getAllRoomMessages, probeRoomMessages, getLiveDanmakuMessages, getRoomInfo, getRoomList,
  getMemberInfo, getStarList, getMemberList, getGroupList,
  getFollowedIds, followMember, unfollowMember,
  getCheckinInfo, doCheckin,
  getLiveList, getOneLive, getReplayListPage, getReplayOne,
  getUserInfo, getNewsList,
  _internals: { createAppInfo, createPa, loginRequestHeaders, normalizeVerificationChallenge, requestHeaders, replayListBody, REQUEST_TIMEOUT_MS, LIVE_ONE_PATH, TOKEN_PATH, validateStoredToken, persistToken, authStatus },
};
