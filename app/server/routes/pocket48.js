"use strict";

const express = require("express");
const router = express.Router();
const pocket48 = require("../modules/pocket48/api");
const roomDirectory = require("../modules/pocket48/room-directory");
const pocketRecorder = require("../modules/pocket48/recorder");
const autoRecorder = require("../modules/pocket48/auto-recorder");
const members = require("../modules/pocket48/members");
const roomState = require("../modules/pocket48/room-state");
const cli = require("../lib/cli");
router.use('/account', require('./pocket48-account'));

// Pocket48 credentials are valuable even though they are distinct from the
// administrator password.  Apply a small in-memory brake to credential writes
// as a second line of defence behind the administrator session.
const credentialAttempts = new Map();
const smsSendAttempts = new Map();
const CREDENTIAL_WINDOW_MS = Math.max(60_000, Number(process.env.POCKET48_LOGIN_WINDOW_MS) || 15 * 60 * 1000);
const CREDENTIAL_MAX_FAILURES = Math.max(1, Number(process.env.POCKET48_LOGIN_MAX_FAILURES) || 5);
const SMS_SEND_WINDOW_MS = Math.max(60_000, Number(process.env.POCKET48_SMS_WINDOW_MS) || 15 * 60 * 1000);
const SMS_SEND_MAX = Math.max(1, Number(process.env.POCKET48_SMS_MAX_SENDS) || 5);
const SMS_SEND_COOLDOWN_MS = Math.max(30_000, Number(process.env.POCKET48_SMS_COOLDOWN_MS) || 60_000);
const rateLimitSalt = require("crypto").randomBytes(32);

function attemptKey(req) { return String(req.ip || req.socket?.remoteAddress || "unknown"); }
function mobileKey(mobile) { return require("crypto").createHmac("sha256", rateLimitSalt).update(String(mobile)).digest("hex"); }
function credentialKeys(req, mobile) { return [attemptKey(req), ...(mobile ? [`mobile:${mobileKey(mobile)}`] : [])]; }
function failureState(key) {
  const now = Date.now();
  let state = credentialAttempts.get(key);
  if (!state || state.resetAt <= now) {
    if (credentialAttempts.size >= 10_000) credentialAttempts.delete(credentialAttempts.keys().next().value);
    state = { failures: 0, resetAt: now + CREDENTIAL_WINDOW_MS };
    credentialAttempts.set(key, state);
  }
  return state;
}
function limited(req, mobile) { return credentialKeys(req, mobile).some(key => failureState(key).failures >= CREDENTIAL_MAX_FAILURES); }
function failed(req, mobile) { credentialKeys(req, mobile).forEach(key => { failureState(key).failures += 1; }); }
function succeeded(req, mobile) { credentialKeys(req, mobile).forEach(key => credentialAttempts.delete(key)); }
function validMobile(value) { return typeof value === "string" && /^1\d{10}$/.test(value); }
function validPassword(value) { return typeof value === "string" && value.length >= 1 && value.length <= 256; }
function validAccessToken(value) { return typeof value === "string" && value.length >= 1 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value); }
function validSmsCode(value) { return typeof value === "string" && /^\d{4,8}$/.test(value); }
function validChallengeAnswer(value) { return value === undefined || (typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value)); }

function smsLimitKeys(req, mobile) { return [`ip:${attemptKey(req)}`, `mobile:${mobileKey(mobile)}`]; }
function consumeSmsSend(req, mobile, { now = Date.now(), bypassCooldown = false } = {}) {
  const keys = smsLimitKeys(req, mobile);
  const states = keys.map((key) => {
    let state = smsSendAttempts.get(key);
    if (!state || state.resetAt <= now) state = { count: 0, lastSentAt: 0, resetAt: now + SMS_SEND_WINDOW_MS };
    return { key, state };
  });
  const waitMs = Math.max(...states.map(({ state }) => state.lastSentAt > 0 ? Math.max(0, state.lastSentAt + SMS_SEND_COOLDOWN_MS - now) : 0));
  if (!bypassCooldown && waitMs > 0) return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  const exhausted = states.find(({ state }) => state.count >= SMS_SEND_MAX);
  if (exhausted) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((exhausted.state.resetAt - now) / 1000)) };
  states.forEach(({ key, state }) => {
    if (smsSendAttempts.size >= 10_000 && !smsSendAttempts.has(key)) smsSendAttempts.delete(smsSendAttempts.keys().next().value);
    smsSendAttempts.set(key, { ...state, count: state.count + 1, lastSentAt: now });
  });
  return { allowed: true, retryAfterSeconds: Math.ceil(SMS_SEND_COOLDOWN_MS / 1000) };
}

// ---- Pocket48 recording ----
router.get("/recordings/active", (_req, res) => {
  res.json({ success: true, data: pocketRecorder.listActive() });
});

router.post("/recordings/start", async (req, res) => {
  try {
    const { liveId } = req.body || {};
    if (!liveId) return res.status(400).json({ success: false, error: "liveId is required" });
    const recording = await pocketRecorder.start(String(liveId));
    res.status(201).json({ success: true, data: recording });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/recordings/:recordingId/stop", async (req, res) => {
  try {
    const recording = await pocketRecorder.stop(req.params.recordingId, { manual: true });
    res.json({ success: true, data: recording });
  } catch (err) {
    const status = err.message === "Active recording not found" ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ---- Automatic recording ----
router.get("/auto-recording", (_req, res) => {
  res.json({ success: true, data: autoRecorder.getStatus() });
});

router.put("/auto-recording", (req, res) => {
  try {
    const data = autoRecorder.setConfig(req.body || {});
    // Turning the feature off means no recording is expected: drop any stale
    // "blocked" banner instead of leaving a warning that nothing will clear.
    if (!data.enabled) autoRecorder.clearBlocked();
    // Start the first pass now so the saved page reflects a real attempt.
    if (data.enabled) void autoRecorder.poll();
    res.json({ success: true, data: autoRecorder.getStatus() });
  }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.post("/auto-recording/poll", async (_req, res) => {
  res.json({ success: true, data: await autoRecorder.poll() });
});

// ---- Pocket48 authentication ----
// SMS is the primary login path. Password login remains for compatibility and
// token login remains an advanced recovery option.
router.get("/auth/status", async (_req, res) => {
  res.json({ success: true, data: await pocket48.getAuthStatus() });
});

router.post("/login/sms/send", async (req, res) => {
  const { mobile, answer } = req.body || {};
  if (!validMobile(mobile) || !validChallengeAnswer(answer)) {
    return res.status(400).json({ success: false, error: "请输入有效手机号和安全验证答案" });
  }
  const limit = consumeSmsSend(req, mobile, { bypassCooldown: Boolean(answer) });
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ success: false, error: `请求过于频繁，请在 ${limit.retryAfterSeconds} 秒后重试` });
  }
  try {
    const result = await pocket48.sendSmsCode(mobile, answer);
    if (result.success) {
      return res.json({ success: true, data: { sent: true, cooldownSeconds: limit.retryAfterSeconds } });
    }
    if (result.reason === "verification_required" && result.challenge) {
      return res.status(409).json({
        success: false,
        code: "POCKET48_VERIFICATION_REQUIRED",
        error: "请先完成安全验证，再重新获取验证码",
        data: { challenge: result.challenge },
      });
    }
    return res.status(400).json({ success: false, error: "验证码发送失败，请稍后重试" });
  } catch (_error) {
    return res.status(502).json({ success: false, error: "Pocket48 短信服务暂时不可用" });
  }
});

router.post("/login/sms/verify", async (req, res) => {
  const { mobile, code } = req.body || {};
  if (!validMobile(mobile) || !validSmsCode(code)) {
    return res.status(400).json({ success: false, error: "请输入有效手机号和短信验证码" });
  }
  if (limited(req, mobile)) return res.status(429).json({ success: false, error: "登录尝试过多，请稍后重试" });
  try {
    const result = await pocket48.loginWithCode(mobile, code);
    if (!result.success) {
      failed(req, mobile);
      return res.status(401).json({ success: false, errorCode: "POCKET48_LOGIN_REJECTED", error: "验证码无效或已过期" });
    }
    succeeded(req, mobile);
    return res.json({ success: true, data: result.data });
  } catch (_error) {
    failed(req, mobile);
    return res.status(502).json({ success: false, error: "Pocket48 登录服务暂时不可用" });
  }
});

router.post("/login", async (req, res) => {
  try {
    if (limited(req)) return res.status(429).json({ success: false, error: "登录尝试过多，请稍后重试" });
    const { mobile, password } = req.body || {};
    if (!validMobile(mobile) || !validPassword(password)) {
      return res.status(400).json({ success: false, error: "请输入有效的中国大陆手机号和口袋48密码" });
    }
    const result = await pocket48.login(mobile, password);
    if (!result.success) {
      failed(req);
      return res.status(401).json({ success: false, errorCode: "POCKET48_LOGIN_REJECTED", error: "口袋48未接受登录，请检查手机号和密码，或尝试短信登录" });
    }
    succeeded(req);
    // `result.data` is already the deliberately safe account DTO.  Do not add
    // a mobile number or token to this response.
    res.json({ success: true, data: result.data });
  } catch (err) {
    failed(req);
    res.status(502).json({ success: false, error: "口袋48登录服务暂不可用，请稍后重试" });
  }
});

router.post("/token", async (req, res) => {
  try {
    if (limited(req)) return res.status(429).json({ success: false, error: "登录尝试过多，请稍后重试" });
    const accessToken = req.body && req.body.token;
    if (!validAccessToken(accessToken)) return res.status(400).json({ success: false, error: "请输入有效的口袋48访问凭据 Token" });
    const result = await pocket48.saveAccessToken(accessToken);
    if (!result.success) {
      failed(req);
      return res.status(401).json({ success: false, errorCode: "POCKET48_LOGIN_REJECTED", error: "口袋48已拒绝此凭据，请检查是否过期" });
    }
    succeeded(req);
    return res.json({ success: true, data: result.data });
  } catch (_err) {
    failed(req);
    return res.status(502).json({ success: false, error: "口袋48凭据验证暂不可用，请稍后重试" });
  }
});

router.post("/logout", (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ success: false, error: "Set confirm to true to remove the saved Pocket48 credential" });
  }
  pocket48.clearToken();
  res.json({ success: true, data: { authenticated: false } });
});

// Legacy status endpoint retained for existing clients.  It deliberately has
// the same redacted representation as /auth/status.
router.get("/token", (req, res) => {
  res.json({ success: true, data: pocket48.publicTokenInfo() || { authenticated: false } });
});

// ---- Live List ----
router.get("/live", async (req, res) => {
  try {
    const { groupId, next } = req.query;
    const result = await pocket48.getLiveList(groupId || 0, next || "0");
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/live/:liveId", async (req, res) => {
  try {
    const result = await pocket48.getOneLive(req.params.liveId);
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---- Stream URL ----
router.get("/live/:liveId/stream-url", async (req, res) => {
  try {
    const result = await pocket48.getOneLive(req.params.liveId);
    const content = (result.data && result.data.content) || result.data || {};
    const streamUrl = content.playStreamPath || content.streamPath || content.playUrl || content.streamUrl || null;
    if (!streamUrl) {
      return res.status(404).json({ success: false, error: "Stream URL not available" });
    }
    res.json({ success: true, data: { streamUrl, liveId: req.params.liveId, memberName: content.userInfo?.nickname || "", title: content.title || "" } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---- Members ----
router.get("/members", async (req, res) => {
  try {
    const roster = await members.listRoster({ force: req.query.refresh === "1" });
    const groupId = req.query.groupId === undefined ? "" : String(req.query.groupId);
    res.json({ success: true, data: { list: groupId ? roster.list.filter((item) => item.groupIds.includes(groupId)) : roster.list, groups: roster.groups, next: null } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get("/member/:memberId", async (req, res) => {
  try {
    const result = await pocket48.getMemberInfo(req.params.memberId);
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Groups ----
router.get("/groups", async (req, res) => {
  try {
    const roster = await members.listRoster({ force: req.query.refresh === "1" });
    res.json({ success: true, data: { list: roster.groups, next: null } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ---- Rooms ----
router.get("/rooms", async (req, res) => {
  try {
    const result = await pocket48.getRoomList();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/room/:roomId", async (req, res) => {
  try {
    const result = await pocket48.getRoomInfo(req.params.roomId);
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/room/:roomId/messages", async (req, res) => {
  try {
    const { nextTime } = req.query;
    const result = await pocket48.getRoomMessages(req.params.roomId, nextTime);
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Friendships (真正的口袋48 关注/取关) ----
//
// These mutate the logged-in Pocket48 account, unlike the removed local
// "monitor" watch list which only polled room messages and never changed who
// you follow. `friendships/friends/id` is authoritative and includes members
// whose room is hidden from the room list.
//
// `roster` lists everyone you can follow, which is what makes ADDING a follow
// possible at all: the room list only ever contains people already followed.
//
// Every route below must reject an unauthenticated caller BEFORE it calls out:
// without a token the request goes to Pocket48 anonymously and comes back as
// "缺少请求参数" rather than a clean 409.
function requireToken(req, res, next) {
  if (!pocket48.getToken()) return res.status(409).json({ success: false, error: "请先登录口袋48" });
  next();
}

router.get("/friendships/roster", requireToken, async (req, res) => {
  try {
    const [groups, followed] = await Promise.all([
      roomDirectory.roster(),
      pocket48.getFollowedIds(),
    ]);
    const ids = new Set((followed?.data?.content?.data || []).map(String));
    const roomIds = groups.flatMap(g => g.members).map(m => m.roomId).filter(Boolean);
    const known = await roomState.states(pocket48, roomIds, { refresh: req.query.refresh === "1" });
    res.json({
      success: true,
      data: {
        followedCount: ids.size,
        totalCount: groups.reduce((n, g) => n + g.members.length, 0),
        // "gone" rows are still listed and still followable — only their room is
        // revoked upstream, which is a fact the reader needs before clicking.
        goneCount: roomIds.filter(id => known[id] === "gone").length,
        // The readable counterpart of goneCount. Counted from the same probe map
        // as roomState:'ok' below, so the filter button and the rows it filters
        // can never disagree.
        openCount: roomIds.filter(id => known[id] === "ok").length,
        // Rows still waiting on the background probe; they are in neither count.
        unknownCount: roomIds.filter(id => !known[id] || known[id] === "unknown").length,
        groups: groups.map(group => ({
          teamName: group.teamName,
          members: group.members.map(m => ({
            ownerId: m.ownerId,
            ownerName: m.ownerName,
            roomId: m.roomId,
            groupName: m.groupName,
            followed: ids.has(m.ownerId),
            roomState: m.roomId ? (known[m.roomId] || "unknown") : "missing",
          })),
        })),
      },
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get("/friendships/followed", requireToken, async (_req, res) => {
  try {
    const followed = await pocket48.getFollowedIds();
    const ids = (followed?.data?.content?.data || []).map(String);
    res.json({ success: true, data: { count: ids.length, ownerIds: ids } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post("/friendships/followed", requireToken, async (req, res) => {
  const ownerId = String(req.body?.ownerId ?? "").trim();
  if (!/^\d{1,30}$/.test(ownerId)) return res.status(400).json({ success: false, error: "成员 ID 无效" });
  try {
    const result = await pocket48.followMember(ownerId);
    if (result?.data?.success === false) return res.status(502).json({ success: false, error: result.data.message || "关注失败" });
    res.json({ success: true, data: { ownerId, followed: true } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

router.delete("/friendships/followed/:ownerId", requireToken, async (req, res) => {
  const ownerId = String(req.params.ownerId || "").trim();
  if (!/^\d{1,30}$/.test(ownerId)) return res.status(400).json({ success: false, error: "成员 ID 无效" });
  try {
    const result = await pocket48.unfollowMember(ownerId);
    if (result?.data?.success === false) return res.status(502).json({ success: false, error: result.data.message || "取关失败" });
    res.json({ success: true, data: { ownerId, followed: false } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ---- Check-in ----
router.post("/checkin", async (req, res) => {
  try {
    const result = await pocket48.doCheckin();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/checkin", async (req, res) => {
  try {
    const result = await pocket48.getCheckinInfo();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- User ----
router.get("/user", async (req, res) => {
  try {
    const result = await pocket48.getUserInfo();
    res.json({ success: true, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports._internals = { credentialAttempts, smsSendAttempts, failureState, consumeSmsSend, validMobile, validPassword, validAccessToken, validSmsCode, validChallengeAnswer };
