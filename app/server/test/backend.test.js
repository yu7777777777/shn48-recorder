"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { EventEmitter } = require("events");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-backend-test-"));
process.env.DATA_DIR = testDataDir;
process.env.ADMIN_USERNAME = "admin-test";
process.env.ADMIN_PASSWORD = "password-test";
process.env.SESSION_SECRET = "test-secret-with-more-than-sixteen-characters";

const auth = require("../lib/admin-auth");
const live = require("../modules/pocket48/live");
const replay = require("../modules/pocket48/replay");
const replayProxy = require("../modules/pocket48/replay-proxy");
const replayDanmaku = require("../modules/pocket48/replay-danmaku");
const pocketApi = require("../modules/pocket48/api");
const { DanmakuManager, normalizeMessage: normalizeDanmakuMessage } = require("../modules/pocket48/danmaku");
const streamProxy = require("../modules/pocket48/stream-proxy");
const playbackPolicy = require("../modules/pocket48/playback-policy");
const { createRelayManager } = require("../modules/pocket48/rtmp-relay");
const manager = require("../modules/recorder/manager");
const recorder = require("../modules/pocket48/recorder");
const archiveProcessor = require("../modules/recorder/archive-processor");
const autoRecorder = require("../modules/pocket48/auto-recorder");
const memberCatalog = require("../modules/pocket48/members");
const biliDraft = require("../modules/bilibili/draft");
const biliQueue = require("../modules/bilibili/queue");
const recordingsRoute = require("../routes/recordings");
const pocket48Route = require("../routes/pocket48");
const { createAccountService } = require("../modules/bilibili/account");
const { createGracefulShutdown } = require("../lib/graceful-shutdown");
const { getStorageStats } = require("../index");
const liveOneFixture = require("./fixtures/pocket48-live-one.json");
const replayManifestFixture = fs.readFileSync(path.join(__dirname, "fixtures", "pocket48-replay-manifest.m3u8"), "utf8");
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function equivalentNonCanonicalBase64Url(token) {
  const remainder = token.length % 4;
  if (remainder === 0) return `${token}=`;
  if (remainder !== 2 && remainder !== 3) throw new Error("Unexpected canonical base64url length");
  const lastValue = BASE64URL_ALPHABET.indexOf(token.at(-1));
  const alternateValue = lastValue | 1;
  if (alternateValue === lastValue) throw new Error("Canonical base64url had non-zero padding bits");
  return `${token.slice(0, -1)}${BASE64URL_ALPHABET[alternateValue]}`;
}

test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

test("storage stats report the recording filesystem without exposing its path", () => {
  const storage = getStorageStats(testDataDir, () => ({
    bsize: 4096n,
    blocks: 10_000n,
    bavail: 2_500n,
  }));
  assert.deepEqual(storage, {
    total: 40_960_000,
    free: 10_240_000,
    used: 30_720_000,
    usedPercent: 75,
  });
  assert.equal(JSON.stringify(storage).includes(testDataDir), false);
});

test("admin credentials are checked and session cookie is signed", () => {
  assert.equal(auth.verifyCredentials("admin-test", "password-test"), true);
  assert.equal(auth.verifyCredentials("admin-test", "bad"), false);
  const headers = {};
  const req = { headers: {}, secure: false };
  const res = { setHeader(name, value) { headers[name] = value; } };
  const created = auth.createSession(req, res);
  assert.match(headers["Set-Cookie"], /HttpOnly/);
  assert.match(headers["Set-Cookie"], /SameSite=Strict/);
  const cookie = headers["Set-Cookie"].split(";", 1)[0];
  const session = auth.getSession({ headers: { cookie } });
  assert.equal(session.id, created.id);
});

test("remembered admin sessions expire after 30 days and can be revoked", () => {
  const headers = {};
  const res = { setHeader(name, value) { headers[name] = value; } };
  const req = { headers: {}, secure: true };
  for (const rememberMe of [false, "true", true]) {
    const session = auth.createSession(req, res, { rememberMe });
    const ttl = rememberMe === true ? 30 * 24 * 60 * 60 * 1000 : auth.SESSION_TTL_MS;
    assert.equal(session.expiresAt - session.createdAt, ttl);
    assert.match(headers["Set-Cookie"], new RegExp(`Max-Age=${Math.floor(ttl / 1000)}(?:;|$)`));
    assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Strict; Secure/);
    const authenticatedRequest = { headers: { cookie: headers["Set-Cookie"].split(";", 1)[0] } };
    assert.equal(auth.getSession(authenticatedRequest), session);
    if (rememberMe === true) {
      session.expiresAt = Date.now() - 1;
      assert.equal(auth.getSession(authenticatedRequest), null);
    }
    auth.destroySession(authenticatedRequest, res);
    assert.equal(auth.getSession(authenticatedRequest), null);
    assert.match(headers["Set-Cookie"], /Max-Age=0/);
  }
});

test("administrator credentials are validated, hashed, persisted atomically and reloadable", () => {
  const credentialPath = path.join(testDataDir, "auth-test", "admin-credentials.json");
  const environment = { ADMIN_USERNAME: "initial-admin", ADMIN_PASSWORD: "Initial-pass-123" };
  const store = auth._internals.createCredentialStore({ filePath: credentialPath, environment });

  assert.equal(store.verify("initial-admin", "Initial-pass-123"), true);
  assert.deepEqual(store.update({ currentPassword: "wrong", newUsername: "new-admin" }), {
    ok: false,
    status: 401,
    error: "Current password is incorrect",
  });
  assert.equal(fs.existsSync(credentialPath), false);
  assert.equal(store.update({ currentPassword: "Initial-pass-123", newPassword: "short" }).status, 400);

  assert.deepEqual(store.update({
    currentPassword: "Initial-pass-123",
    newUsername: "new-admin",
  }), { ok: true });
  assert.equal(store.verify("initial-admin", "Initial-pass-123"), false);
  assert.equal(store.verify("new-admin", "Initial-pass-123"), true);

  assert.deepEqual(store.update({
    currentPassword: "Initial-pass-123",
    newPassword: "New-passphrase-456",
  }), { ok: true });
  assert.equal(store.verify("new-admin", "Initial-pass-123"), false);
  assert.equal(store.verify("new-admin", "New-passphrase-456"), true);

  const serialized = fs.readFileSync(credentialPath, "utf8");
  assert.equal(serialized.includes("Initial-pass-123"), false);
  assert.equal(serialized.includes("New-passphrase-456"), false);
  assert.match(serialized, /"algorithm": "scrypt"/);
  assert.equal(fs.readdirSync(path.dirname(credentialPath)).some((name) => name.endsWith(".tmp")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(credentialPath).mode & 0o777, 0o600);

  const reloaded = auth._internals.createCredentialStore({ filePath: credentialPath, environment });
  assert.equal(reloaded.currentUsername(), "new-admin");
  assert.equal(reloaded.verify("new-admin", "New-passphrase-456"), true);
  assert.equal(reloaded.verify("initial-admin", "Initial-pass-123"), false);
});

test("credential changes invalidate every administrator session", () => {
  auth._internals.sessions.clear();
  const firstHeaders = {};
  const secondHeaders = {};
  const req = { headers: {}, secure: false };
  auth.createSession(req, { setHeader(name, value) { firstHeaders[name] = value; } });
  auth.createSession(req, { setHeader(name, value) { secondHeaders[name] = value; } });
  assert.equal(auth._internals.sessions.size, 2);

  const clearedHeaders = {};
  auth.destroyAllSessions(req, { setHeader(name, value) { clearedHeaders[name] = value; } });
  assert.equal(auth._internals.sessions.size, 0);
  assert.match(clearedHeaders["Set-Cookie"], /Max-Age=0/);
});

test("public live normalization omits raw stream and credential fields", () => {
  const normalized = live.normalizeLive({
    liveId: 123,
    roomId: "13463786167",
    title: "测试直播",
    playStreamPath: "https://cdn.example/live.flv?token=secret",
    token: "must-not-leak",
    coverPath: "/2026/0611/cover.jpg",
    userInfo: { userId: 456, nickname: "成员", avatar: "/avatar/2026/member.jpg" },
  });
  assert.deepEqual(Object.keys(normalized).sort(), ["cover", "liveId", "liveType", "member", "startedAt", "title"]);
  assert.equal(live.findRoomId({ chatroomId: "13463786167" }), "13463786167");
  assert.equal(live.findRoomId({ roomId: "1346<script>" }), "");
  assert.equal(JSON.stringify(normalized).includes("secret"), false);
  assert.equal(normalized.cover, "https://source3.48.cn/2026/0611/cover.jpg");
  assert.equal(normalized.member.avatar, "https://source3.48.cn/avatar/2026/member.jpg");
  assert.equal(live.findStreamUrl({ playStreamPath: "https://cdn.example/live.flv" }), "https://cdn.example/live.flv");
  assert.equal(live.findStreamUrl({ playStreamPath: "rtmp://idol.tv.48.cn/live/member" }), "rtmp://idol.tv.48.cn/live/member");
});

test("Pocket48 request headers follow the current app-shaped contract", () => {
  const headers = pocketApi._internals.requestHeaders();
  const appInfo = JSON.parse(headers.appInfo);
  assert.equal(headers["Accept-Language"], "zh-Hans-AW;q=1");
  assert.equal(appInfo.appVersion, "7.0.4");
  assert.match(appInfo.deviceId, /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/);
  assert.equal(pocketApi._internals.LIVE_ONE_PATH, "/live/api/v1/live/getLiveOne");
  assert.deepEqual(pocketApi._internals.replayListBody({ next: "123", userId: "456" }), {
    debug: true,
    next: "123",
    record: true,
    userId: "456",
  });
});

test("Pocket48 login signatures match the current wire format without exposing credentials", () => {
  const pa = pocketApi._internals.createPa({
    now: 1700000000000,
    uuid: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(
    Buffer.from(pa, "base64").toString("utf8"),
    "1700000000000000000000000400080000000000000007b467e0e8b1dfe53ae10df97714676e62021060901"
  );
  const headers = pocketApi._internals.loginRequestHeaders();
  const appInfo = JSON.parse(headers.appInfo);
  assert.match(headers.pa, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(appInfo.appVersion, "7.0.41");
  assert.equal(appInfo.appBuild, "24011601");
  assert.equal(Object.hasOwn(headers, "token"), false);
});

test("Pocket48 public account info never includes the stored token", () => {
  assert.equal(JSON.stringify(pocketApi.publicTokenInfo({ token: "pocket-secret", userId: "42", nickname: "测试" })).includes("secret"), false);
});

test("Pocket48 account status distinguishes an invalid saved credential from an authenticated session", () => {
  const token = { token: "pocket-secret", userId: "42", nickname: "测试" };
  assert.deepEqual(pocketApi._internals.authStatus(null, "not_logged_in"), {
    authenticated: false,
    credentialsPresent: false,
    health: "not_logged_in",
    upstreamAvailable: null,
  });
  assert.deepEqual(pocketApi._internals.authStatus(token, "invalid", { upstreamAvailable: true }), {
    authenticated: false,
    credentialsPresent: true,
    health: "invalid",
    upstreamAvailable: true,
    account: { userId: "42", nickname: "测试" },
  });
  assert.equal(JSON.stringify(pocketApi._internals.authStatus(token, "invalid")).includes("secret"), false);
});

test("danmaku manager shares one room poller and emits only safe display DTOs", async () => {
  let pollCalls = 0;
  const events = [];
  const service = new DanmakuManager({
    api: { getAllRoomMessages: async roomId => {
      pollCalls += 1;
      assert.equal(roomId, "13463786167");
      return { status: 200, data: { status: 200, content: { message: [
        { msgIdClient: "rest-1", msgTime: 1, msgType: "TEXT", bodys: " 你好 ", extInfo: JSON.stringify({ user: { nickName: "观众" }, token: "rest-secret" }) },
        { idClient: "msg-1", msgTime: 2, type: "custom", custom: JSON.stringify({ messageType: "BARRAGE_MEMBER", text: " 直播真好看 ", token: "raw-secret", user: { nickName: "成员" } }) },
        { idClient: "gift-1", msgTime: 3, type: "custom", custom: JSON.stringify({ messageType: "PRESENT_NORMAL", giftInfo: { giftName: "礼物" } }) },
      ] } } };
    } },
    pollMs: 1_000,
    idleMs: 1,
  });
  const first = service.subscribe("13463786167", (event, data) => events.push({ event, data }));
  const second = service.subscribe("13463786167", (event, data) => events.push({ event, data }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getStats().rooms, 1);
  assert.equal(service.getStats().subscribers, 2);
  assert.equal(pollCalls, 1);
  assert.ok(events.some(item => item.event === "status" && item.data.status === "connected"));
  assert.deepEqual([...new Map(events.filter(item => item.event === "danmaku").map(item => [item.data.id, item.data])).values()], [
    { id: "rest-1", nickname: "观众", text: "你好", member: false },
    { id: "msg-1", nickname: "成员", text: "直播真好看", member: true },
  ]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(normalizeDanmakuMessage({ type: "custom", custom: JSON.stringify({ messageType: "PRESENT_NORMAL" }) }), null);
  first();
  second();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getStats().rooms, 0);
  service.closeAll();
});

test("Pocket48 SMS challenges are reduced to a bounded safe DTO", () => {
  assert.deepEqual(
    pocketApi._internals.normalizeVerificationChallenge(JSON.stringify({
      question: "请选择蓝色图案",
      answer: ["A", { label: "选项 B", value: "B", secret: "drop-me" }],
      token: "must-not-leak",
    })),
    {
      question: "请选择蓝色图案",
      options: [{ label: "A", value: "A" }, { label: "选项 B", value: "B" }],
    }
  );
  assert.equal(pocketApi._internals.normalizeVerificationChallenge("not-json"), null);
});

test("Pocket48 SMS routes validate codes and throttle sends by IP and mobile", () => {
  const internals = pocket48Route._internals;
  internals.smsSendAttempts.clear();
  const req = { ip: "203.0.113.5" };
  assert.equal(internals.validSmsCode("123456"), true);
  assert.equal(internals.validSmsCode("12ab56"), false);
  assert.equal(internals.validChallengeAnswer("答案 A"), true);
  assert.equal(internals.validChallengeAnswer("bad\nanswer"), false);
  assert.deepEqual(internals.consumeSmsSend(req, "13800000000", { now: 1000 }), { allowed: true, retryAfterSeconds: 60 });
  assert.deepEqual(internals.consumeSmsSend(req, "13800000000", { now: 2000 }), { allowed: false, retryAfterSeconds: 59 });
  assert.deepEqual(internals.consumeSmsSend(req, "13800000000", { now: 2000, bypassCooldown: true }), { allowed: true, retryAfterSeconds: 60 });
  internals.smsSendAttempts.clear();
});

test("Pocket48 credential persistence is atomic, mode-restricted, and never exposed by its status DTO", () => {
  const secret = "p48-test-access-token-that-must-not-leak";
  const tokenPath = pocketApi._internals.TOKEN_PATH;
  pocketApi.clearToken();
  pocketApi._internals.persistToken({ version: 1, token: secret, userId: "42", nickname: "测试成员", updatedAt: "2026-08-31T00:00:00.000Z" });

  const stored = fs.readFileSync(tokenPath, "utf8");
  assert.match(stored, /p48-test-access-token/);
  assert.equal(fs.readdirSync(path.dirname(tokenPath)).some((name) => name.endsWith(".tmp")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);

  const status = pocketApi.publicTokenInfo();
  assert.deepEqual(status, {
    authenticated: true,
    account: { userId: "42", nickname: "测试成员" },
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(status).includes(secret), false);
  pocketApi.clearToken();
});


test("Pocket48 replay DTO normalizes assets, duration and omits private recording data", () => {
  const normalized = replay.normalizeReplay({
    liveId: "1300162392190947328",
    title: "测试重播",
    coverPath: "/2026/0831/cover.jpg",
    ctime: "1788105600000",
    duration: "1:02:03",
    liveType: 1,
    liveMode: 2,
    status: 3,
    playStreamPath: "https://idol-vod.48.cn/member/secret/index.m3u8?signature=private",
    localPath: "D:/recordings/private.flv",
    recordingId: "rec_private",
    userInfo: { userId: "42", nickname: "成员", avatar: "/avatar/2026/member.jpg" },
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    "cover", "duration", "durationSeconds", "liveId", "liveMode", "liveType", "member", "startedAt", "status", "team", "title",
  ]);
  assert.equal(normalized.cover, "https://source3.48.cn/2026/0831/cover.jpg");
  assert.equal(normalized.member.avatar, "https://source3.48.cn/avatar/2026/member.jpg");
  assert.equal(normalized.durationSeconds, 3723);
  assert.equal(replay.durationSeconds("52:34"), 3154);
  assert.equal(replay.durationSeconds("1:02:03"), 3723);
  assert.equal(replay.durationSeconds("01:70"), null);
  assert.equal(JSON.stringify(normalized).includes("recordings"), false);
  assert.equal(JSON.stringify(normalized).includes("signature"), false);
  assert.equal(JSON.stringify(normalized).includes("rec_private"), false);
});

test("Pocket48 replay danmaku parses synchronized LRC and rejects unsafe sources", () => {
  const parsed = replayDanmaku.parseLrc([
    "[00:00:18.495]用户一\t第一条弹幕",
    "[00:00:18.80]用户二\t第二条弹幕",
    "invalid line",
    "[00:01:02.003]用户三\t送出礼物",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { id: "18495:0", atMs: 18495, nickname: "用户一", text: "第一条弹幕" },
    { id: "18800:1", atMs: 18800, nickname: "用户二", text: "第二条弹幕" },
    { id: "62003:3", atMs: 62003, nickname: "用户三", text: "送出礼物" },
  ]);
  assert.equal(
    replayDanmaku.validateDanmakuUrl("https://source.48.cn/live/lrc/2026/0901/safe.lrc").hostname,
    "source.48.cn"
  );
  assert.throws(() => replayDanmaku.validateDanmakuUrl("http://source.48.cn/live/lrc/unsafe.lrc"), /HTTPS/);
  assert.throws(() => replayDanmaku.validateDanmakuUrl("https://evil.source.48.cn/live/lrc/unsafe.lrc"), /allowlisted/);
  assert.throws(() => replayDanmaku.validateDanmakuUrl("https://source.48.cn/private/unsafe.lrc"), /path is invalid/);
});

test("Pocket48 replay team metadata maps official logos to stable public filters", () => {
  assert.deepEqual(replay.normalizeTeam({ userInfo: { teamLogo: "/mediasource/teamLogo2/all/snh48_s2.png" } }), {
    id: "sii",
    name: "Team SII",
  });
  assert.deepEqual(replay.normalizeTeam({ userInfo: { teamLogo: "/mediasource/teamLogo/fulllogo/snh48_team_yubeisheng.png" } }), {
    id: "trainee",
    name: "预备生",
  });
  assert.deepEqual(replay.normalizeTeam({ userInfo: { teamLogo: "/backstage/2023/0529/4gskw7gl929o9291nfpso16.png" } }), {
    id: "gii",
    name: "Team GII",
  });
  assert.equal(replay.isTeamInGroup("10", "sii"), true);
  assert.equal(replay.isTeamInGroup("11", "sii"), false);
  assert.equal(replay.isTeamInGroup(undefined, "sii"), false);
});

test("Pocket48 replay member first page uses the mature-project cursor workaround", async () => {
  const original = pocketApi.getReplayListPage;
  const calls = [];
  pocketApi.getReplayListPage = async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      return {
        status: 200,
        data: { success: true, status: 200, content: { next: "900", liveList: [
          { liveId: "999", duration: "00:20", userInfo: { userId: "42", nickname: "成员" } },
        ] } },
      };
    }
    return {
      status: 200,
      data: { success: true, status: 200, content: { next: "777", liveList: [
        { liveId: "998", duration: "00:10", userInfo: { userId: "42", nickname: "成员" } },
      ] } },
    };
  };
  try {
    const result = await replay.listReplays({ next: "0", userId: "42" });
    assert.deepEqual(calls, [{ next: "0" }, { next: "999", groupId: undefined, userId: "42" }]);
    assert.deepEqual(result.list.map((item) => item.liveId), ["999", "998"]);
    assert.equal(result.next, "777");
  } finally {
    pocketApi.getReplayListPage = original;
    replay._internals.metadataCache.clear();
  }
});

test("Pocket48 member replay search collects up to thirty recent items", async () => {
  const original = pocketApi.getReplayListPage;
  const calls = [];
  const makeList = (start, count) => Array.from({ length: count }, (_value, index) => ({
    liveId: String(start - index), duration: "00:10", userInfo: { userId: "42", nickname: "陈琳" },
  }));
  pocketApi.getReplayListPage = async (options) => {
    calls.push(options);
    if (calls.length === 1) return { status: 200, data: { success: true, status: 200, content: { liveList: [{ liveId: "999", userInfo: { userId: "1" } }] } } };
    if (calls.length === 2) return { status: 200, data: { success: true, status: 200, content: { next: "800", liveList: makeList(950, 20) } } };
    return { status: 200, data: { success: true, status: 200, content: { next: "0", liveList: makeList(930, 20) } } };
  };
  try {
    const result = await replay.listReplays({ next: "0", userId: "42", limit: 30 });
    assert.equal(result.list.length, 30);
    assert.equal(calls.length, 3);
    assert.equal(result.list[0].member.name, "陈琳");
  } finally {
    pocketApi.getReplayListPage = original;
    replay._internals.metadataCache.clear();
  }
});

test("Pocket48 replay team filter scans pages and keeps the upstream cursor", async () => {
  const original = pocketApi.getReplayListPage;
  const calls = [];
  pocketApi.getReplayListPage = async (options) => {
    calls.push(options);
    const firstPage = calls.length === 1;
    return {
      status: 200,
      data: { success: true, status: 200, content: {
        next: firstPage ? "800" : "0",
        liveList: [{
          liveId: firstPage ? "901" : "900",
          duration: "00:10",
          userInfo: {
            userId: firstPage ? "41" : "42",
            nickname: firstPage ? "其他队成员" : "目标队成员",
            teamLogo: firstPage
              ? "/mediasource/teamLogo2/all/snh48_x.png"
              : "/mediasource/teamLogo2/all/snh48_s2.png",
          },
        }],
      } },
    };
  };
  try {
    const result = await replay.listReplays({ next: "0", groupId: "10", teamId: "sii" });
    assert.deepEqual(calls, [
      { next: "0", groupId: "10", userId: undefined },
      { next: "800", groupId: "10", userId: undefined },
    ]);
    assert.deepEqual(result.list.map(item => item.liveId), ["900"]);
    assert.equal(result.next, "0");
  } finally {
    pocketApi.getReplayListPage = original;
    replay._internals.metadataCache.clear();
  }
});

test("Pocket48 getLiveOne fixture normalizes assets and detects its RTMP stream", () => {
  const wrapped = { status: 200, data: liveOneFixture };
  assert.doesNotThrow(() => live._internals.assertSuccessfulResult(wrapped));
  const content = live._internals.contentOf(wrapped);
  const normalized = live.normalizeLive(content);
  assert.equal(normalized.member.name, "测试成员");
  assert.equal(normalized.cover, "https://source3.48.cn/2026/0611/example-cover.jpg");
  assert.equal(normalized.member.avatar, "https://source3.48.cn/avatar/2026/example-avatar.jpg");
  assert.equal(live.findStreamUrl(content), "rtmp://idol.tv.48.cn/live/test-stream");
  assert.equal(live.playbackProtocol(live.findStreamUrl(content)), "flv");
  assert.equal(live.playbackProtocol("https://cdn.example/live?id=1&format=hls"), "hls");
});

test("live playback policy defaults to viewer direct delivery with an on-demand server fallback", () => {
  const fakeProxy = {
    _internals: { validateUrl: value => new URL(value) },
    createToken: () => ({ token: "opaque-server-token", expiresAt: Date.parse("2026-08-31T12:00:00.000Z") }),
  };
  const direct = playbackPolicy.createHttpPlayback({
    liveId: "123",
    streamUrl: "https://cdn.example/live.flv?signature=viewer-link",
    protocol: "flv",
    priority: "direct_first",
    streamProxy: fakeProxy,
  });
  assert.deepEqual(direct, {
    liveId: "123",
    protocol: "flv",
    playUrl: "https://cdn.example/live.flv?signature=viewer-link",
    fallbackAvailable: true,
  });

  const server = playbackPolicy.createHttpPlayback({
    liveId: "123",
    streamUrl: "https://cdn.example/live.flv?signature=viewer-link",
    protocol: "flv",
    priority: "direct_first",
    forceServer: true,
    streamProxy: fakeProxy,
  });
  assert.deepEqual(server, {
    liveId: "123",
    protocol: "flv",
    playUrl: "/api/public/streams/opaque-server-token",
    expiresAt: "2026-08-31T12:00:00.000Z",
    fallbackAvailable: false,
  });
  assert.equal(playbackPolicy.normalizeLivePriority("server"), "server");
  assert.equal(playbackPolicy.normalizeLivePriority("invalid"), "direct_first");
});

test("stream proxy rejects private targets and rewrites every HLS resource to opaque tokens", () => {
  assert.throws(() => streamProxy.createToken("http://127.0.0.1/private"), /Private/);
  assert.throws(() => streamProxy.createToken("rtmp://idol.tv.48.cn/live/member"), /Unsupported/);
  const manifest = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nsegment-1.ts\n";
  const rewritten = streamProxy._internals.rewriteManifest(manifest, "https://cdn.example/live/index.m3u8");
  assert.equal(rewritten.includes("cdn.example"), false);
  assert.match(rewritten, /\/api\/public\/streams\/[A-Za-z0-9_-]+/);
  assert.equal(rewritten.includes("segment-1.ts"), false);
});

test("replay proxy keeps one bounded session for 540 HLS segments and late tokens remain valid", () => {
  const originalNow = Date.now;
  let now = 1_900_000_000_000;
  Date.now = () => now;
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
  try {
    const issued = replayProxy.getOrCreate({
      replayId: "replay-540",
      streamUrl: "https://idol-vod.48.cn/entry/manifests/member/index.m3u8?signature=hidden",
      durationSeconds: replay.durationSeconds("52:34"),
    });
    const sessionToken = issued.playUrl.split("/").at(-2);
    const session = replayProxy._internals.sessions.get(sessionToken);
    const manifest = ["#EXTM3U", ...Array.from({ length: 540 }, (_value, index) => `/vod-segments/safe-replay/segment-${index}.ts`)].join("\n");
    const rewritten = replayProxy._internals.rewriteManifest(manifest, session.rootUrl, session);
    const childTokens = rewritten.split("\n").filter((line) => !line.startsWith("#")).map((line) => line.split("/").at(-1));
    assert.equal(childTokens.length, 540);
    assert.equal(replayProxy._internals.sessions.size, 1);
    assert.equal(replayProxy._internals.replaySessions.size, 1);
    assert.equal(session.scope.resourcePathPrefixes.size, 2);
    assert.equal(rewritten.includes("idol-vod.48.cn"), false);
    assert.equal(rewritten.includes("signature=hidden"), false);

    now += 20 * 60 * 1000;
    assert.ok(replayProxy._internals.resolveSession(sessionToken));
    now += 20 * 60 * 1000;
    assert.ok(replayProxy._internals.resolveSession(sessionToken));
    now += 20 * 60 * 1000;
    const active = replayProxy._internals.resolveSession(sessionToken);
    assert.ok(active);
    assert.match(replayProxy._internals.openChild(active, childTokens.at(-1)), /\/vod-segments\/safe-replay\/segment-539\.ts$/);
    const childToken = childTokens.at(-1);
    const nonCanonical = equivalentNonCanonicalBase64Url(childToken);
    assert.equal(Buffer.from(nonCanonical, "base64url").equals(Buffer.from(childToken, "base64url")), true);
    assert.equal(replayProxy._internals.openChild(active, nonCanonical), null);
    assert.equal(replayProxy._internals.openChild(active, `${childToken} `), null);

    const tamperedBytes = Buffer.from(childToken, "base64url");
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    const tampered = tamperedBytes.toString("base64url");
    assert.notEqual(tampered, childToken);
    assert.equal(replayProxy._internals.openChild(active, tampered), null);
    assert.throws(
      () => replayProxy._internals.sealChild(active, "https://idol-vod.48.cn/unlisted/escape.ts"),
      /outside the session scope/
    );
    assert.throws(
      () => replayProxy._internals.validateSourceUrl("https://evil.idol-vod.48.cn/archive/member/index.m3u8"),
      /allowlisted/
    );
    assert.throws(
      () => replayProxy._internals.validateSourceUrl("https://idol-vod.48.cn/%252e%252e/private/index.m3u8"),
      /path traversal/
    );
  } finally {
    Date.now = originalNow;
    replayProxy._internals.sessions.clear();
    replayProxy._internals.replaySessions.clear();
  }
});

test("replay child and session tokens expire exactly at their absolute millisecond boundary", () => {
  const originalNow = Date.now;
  let now = 1_900_100_000_000;
  Date.now = () => now;
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
  try {
    const issued = replayProxy.getOrCreate({
      replayId: "replay-exp-boundary",
      streamUrl: "https://idol-vod.48.cn/entry/member/index.m3u8",
      durationSeconds: 120,
    });
    const sessionToken = issued.playUrl.split("/").at(-2);
    const session = replayProxy._internals.sessions.get(sessionToken);
    const childToken = replayProxy._internals.sealChild(session, "https://idol-vod.48.cn/entry/member/segment.ts");
    now = session.idleExpiresAt - 1;
    assert.ok(replayProxy._internals.resolveSession(sessionToken));
    now = session.maxExpiresAt - 1;
    assert.ok(replayProxy._internals.openChild(session, childToken));
    assert.ok(replayProxy._internals.resolveSession(sessionToken));
    now = session.maxExpiresAt;
    assert.equal(replayProxy._internals.openChild(session, childToken), null);
    assert.equal(replayProxy._internals.resolveSession(sessionToken), null);
  } finally {
    Date.now = originalNow;
    replayProxy._internals.sessions.clear();
    replayProxy._internals.replaySessions.clear();
  }
});

test("replay proxy rewrites Pocket48 root-relative VOD segments outside the entry manifest directory", () => {
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
  const issued = replayProxy.getOrCreate({
    replayId: "replay-root-relative",
    streamUrl: "https://idol-vod.48.cn/entry/manifests/member/index.m3u8?signature=hidden",
    durationSeconds: 120,
  });
  const session = replayProxy._internals.sessions.get(issued.playUrl.split("/").at(-2));
  const rewritten = replayProxy._internals.rewriteManifest(replayManifestFixture, session.rootUrl, session);
  const tokens = rewritten.split("\n").filter((line) => line.startsWith("/api/public/replay-streams/")).map((line) => line.split("/").at(-1));
  assert.equal(tokens.length, 2);
  assert.match(replayProxy._internals.openChild(session, tokens[0]), /^https:\/\/idol-vod\.48\.cn\/vod-segments\/sanitized-replay\/segment-000000\.ts$/);
  assert.equal(rewritten.includes("vod-segments"), false);
  assert.equal(replayProxy._internals.sessions.size, 1);
  assert.equal(session.scope.resourcePathPrefixes.size, 2);
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
});

test("replay manifest-derived path scopes are bounded and never authorize the host root", () => {
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
  const issued = replayProxy.getOrCreate({
    replayId: "replay-scope-bound",
    streamUrl: "https://idol-vod.48.cn/entry/manifests/index.m3u8",
    durationSeconds: 120,
  });
  const session = replayProxy._internals.sessions.get(issued.playUrl.split("/").at(-2));
  assert.throws(
    () => replayProxy._internals.rewriteManifest("#EXTM3U\n/root-segment.ts\n", session.rootUrl, session),
    /scope is too broad/
  );
  const tooManyScopes = [
    "#EXTM3U",
    ...Array.from({ length: replayProxy._internals.MAX_RESOURCE_PREFIXES }, (_value, index) => `/scope-${index}/segment.ts`),
  ].join("\n");
  assert.throws(
    () => replayProxy._internals.rewriteManifest(tooManyScopes, session.rootUrl, session),
    /too many resource scopes/
  );
  assert.equal(session.scope.resourcePathPrefixes.size, 1);
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
});

test("replay manifest decoding supports bounded gzip and rejects unknown encodings", () => {
  const compressed = zlib.gzipSync(Buffer.from(replayManifestFixture));
  assert.equal(replayProxy._internals.decodeManifest(compressed, "gzip"), replayManifestFixture);
  assert.equal(replayProxy._internals.decodeManifest(Buffer.from(replayManifestFixture), "identity"), replayManifestFixture);
  assert.throws(() => replayProxy._internals.decodeManifest(compressed, "zstd"), /Unsupported replay content encoding/);
});

test("replay proxy structured errors never log upstream URLs or exception messages", () => {
  const originalError = console.error;
  const logs = [];
  console.error = (value) => logs.push(String(value));
  try {
    replayProxy._internals.logReplayError(
      "root_manifest_rewrite",
      new Error("https://idol-vod.48.cn/private/index.m3u8?signature=must-not-leak"),
      { host: "idol-vod.48.cn", upstreamStatus: 502, contentType: "application/x-mpegurl; signature=header-must-not-leak", contentEncoding: "identity" }
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.deepEqual(event, {
    event: "pocket48_replay_proxy_error",
    stage: "root_manifest_rewrite",
    code: "SOURCE_REJECTED",
    upstreamStatus: 502,
    upstreamHost: "idol-vod.48.cn",
    contentType: "application/x-mpegurl",
    contentEncoding: "identity",
  });
  assert.equal(logs[0].includes("must-not-leak"), false);
  assert.equal(logs[0].includes("header-must-not-leak"), false);
  assert.equal(logs[0].includes("/private/"), false);
});

test("replay proxy rejects non-HLS sources without allocating a session", () => {
  replayProxy._internals.sessions.clear();
  replayProxy._internals.replaySessions.clear();
  assert.throws(
    () => replayProxy.getOrCreate({
      replayId: "replay-mp4",
      streamUrl: "https://idol-vod.48.cn/archive/member/video.mp4",
      durationSeconds: 60,
    }),
    /format is unsupported/
  );
  assert.equal(replayProxy._internals.sessions.size, 0);
  assert.equal(replayProxy._internals.replaySessions.size, 0);
});

test("RTMP relay shares one process and serves only scoped HLS files", async () => {
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-relay-test-"));
  let spawnCount = 0;
  let capturedArgs;
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stderr = new EventEmitter();
    }
    kill(signal) {
      setImmediate(() => this.emit("close", 0, signal));
      return true;
    }
  }
  const relay = createRelayManager({
    baseDir: relayDir,
    startupTimeoutMs: 1000,
    idleTimeoutMs: 10_000,
    pollMs: 10,
    lookup: (_hostname, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }]),
    spawn: (_binary, args) => {
      spawnCount += 1;
      capturedArgs = args;
      const manifestPath = args.at(-1);
      const segmentTemplate = args[args.indexOf("-hls_segment_filename") + 1];
      setImmediate(() => {
        fs.writeFileSync(segmentTemplate.replace("%06d", "000000"), "segment");
        fs.writeFileSync(manifestPath, "#EXTM3U\n#EXTINF:2,\nsegment_000000.ts\n");
      });
      return new FakeChild();
    },
  });
  try {
    const [first, second] = await Promise.all([
      relay.getOrStart({ liveId: "live-1", streamUrl: "rtmp://idol.tv.48.cn/live/signed-one" }),
      relay.getOrStart({ liveId: "live-1", streamUrl: "rtmp://idol.tv.48.cn/live/signed-one" }),
    ]);
    assert.equal(spawnCount, 1);
    assert.equal(first.token, second.token);
    assert.equal(first.playUrl, `/api/public/relays/${first.token}/index.m3u8`);
    assert.equal(JSON.stringify(first).includes("rtmp://"), false);
    assert.ok(relay.resolveFile(first.token, "index.m3u8"));
    assert.ok(relay.resolveFile(first.token, "segment_000000.ts"));
    assert.equal(relay.resolveFile(first.token, "../index.m3u8"), null);
    assert.equal(relay.resolveFile(first.token, "other.m3u8"), null);
    assert.equal(relay.resolveFile("unknown", "index.m3u8"), null);
    assert.ok(capturedArgs.includes("hls"));
    assert.throws(() => relay._internals.validateRtmpUrl("rtmp://127.0.0.1/live/test"), /Private/);
    assert.throws(() => relay._internals.validateRtmpUrl("rtmp://example.com/live/test"), /allowlisted/);
  } finally {
    await relay.closeAll();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("upload enqueue returns the persisted item with an id", () => {
  const item = manager.enqueueUpload({ recordingId: "rec_test", mode: "draft" });
  assert.match(item.id, /^up_/);
  assert.equal(manager.getQueueItem(item.id).recordingId, "rec_test");
});

test("completed Bilibili uploads cannot be enqueued or retried a second time", () => {
  const filePath = path.join(testDataDir, "already-uploaded.mp4");
  fs.writeFileSync(filePath, "video");
  manager.addRecording({
    id: "rec_already_uploaded",
    status: "done",
    title: "已上传录像",
    filePath,
  });
  const completed = manager.enqueueUpload({
    recordingId: "rec_already_uploaded",
    file: filePath,
    title: "已上传录像",
    status: "done",
    progress: 100,
    draftId: "3819778",
    error: "Server restarted during upload",
  });

  assert.throws(
    () => biliQueue.enqueueRecording("rec_already_uploaded", { mode: "draft", autoUpload: true }),
    error => error.statusCode === 409 && error.code === "ALREADY_UPLOADED"
  );
  assert.throws(
    () => biliQueue.retry(completed.id),
    error => error.statusCode === 409 && error.code === "ALREADY_UPLOADED"
  );
  assert.equal(biliQueue.toQueueDto(completed).error, "");
});

test("recording upload state prevents duplicates after its completed queue item is removed", () => {
  const filePath = path.join(testDataDir, "uploaded-without-queue.mp4");
  fs.writeFileSync(filePath, "video");
  manager.addRecording({
    id: "rec_uploaded_without_queue",
    status: "done",
    title: "草稿已存在",
    filePath,
    uploadStatus: "done",
    draftId: "3819779",
  });

  assert.throws(
    () => biliQueue.enqueueRecording("rec_uploaded_without_queue", { mode: "draft", autoUpload: true }),
    error => error.statusCode === 409 && error.code === "ALREADY_UPLOADED"
  );
});

test("recording deletion removes only regular files inside the recordings directory", () => {
  const previousRoot = process.env.RECORDINGS_DIR;
  const root = path.join(testDataDir, "delete-recordings");
  const nested = path.join(root, "pocket48");
  const inside = path.join(nested, "inside.flv");
  const outside = path.join(testDataDir, "outside.flv");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(inside, "video");
  fs.writeFileSync(outside, "private");
  process.env.RECORDINGS_DIR = root;
  try {
    assert.equal(recordingsRoute._internals.deleteRecordingFile({ filePath: inside }), true);
    assert.equal(fs.existsSync(inside), false);
    assert.throws(
      () => recordingsRoute._internals.deleteRecordingFile({ filePath: outside }),
      /outside the recordings directory/
    );
    assert.equal(fs.existsSync(outside), true);
  } finally {
    if (previousRoot === undefined) delete process.env.RECORDINGS_DIR;
    else process.env.RECORDINGS_DIR = previousRoot;
  }
});

test("recording playback resolves only regular files inside the recordings directory", () => {
  const previousRoot = process.env.RECORDINGS_DIR;
  const root = path.join(testDataDir, "playback-recordings");
  const nested = path.join(root, "pocket48");
  const inside = path.join(nested, "inside.flv");
  const outside = path.join(testDataDir, "playback-outside.flv");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(inside, "video");
  fs.writeFileSync(outside, "private");
  process.env.RECORDINGS_DIR = root;
  try {
    assert.equal(recordingsRoute._internals.resolveRecordingFile({ filePath: inside }), fs.realpathSync(inside));
    assert.throws(
      () => recordingsRoute._internals.resolveRecordingFile({ filePath: outside }),
      error => error.statusCode === 400 && /outside the recordings directory/.test(error.message)
    );
    assert.throws(
      () => recordingsRoute._internals.resolveRecordingFile({ filePath: path.join(root, "missing.flv") }),
      error => error.statusCode === 404 && /not found/.test(error.message)
    );
  } finally {
    if (previousRoot === undefined) delete process.env.RECORDINGS_DIR;
    else process.env.RECORDINGS_DIR = previousRoot;
  }
});

test("deleted recordings are hidden from the default archive list", () => {
  manager.addRecording({ id: "rec_deleted_hidden", status: "deleted", title: "已删除录像" });
  assert.equal(manager.getRecordings().some(item => item.id === "rec_deleted_hidden"), false);
  assert.equal(manager.getRecordings({ status: "deleted" }).some(item => item.id === "rec_deleted_hidden"), true);
});

test("Bilibili account status returns only the safe nav profile whitelist", async () => {
  const checkedAt = "2026-08-31T12:00:00.000Z";
  const service = createAccountService({
    now: () => new Date(checkedAt),
    request: async (_method, url, options) => {
      assert.equal(url, "https://api.bilibili.com/x/web-interface/nav");
      assert.equal(options.headers.Cookie, "SESSDATA=private-cookie; bili_jct=private-csrf");
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            isLogin: true,
            mid: 123456,
            uname: "测试账号",
            face: "http://i0.hdslb.com/bfs/face/account.jpg#fragment",
            level_info: { current_level: 6, current_exp: 999999 },
            vipStatus: 1,
            vipType: 2,
            wbi_img: { img_url: "https://secret.example/wbi-key.png" },
            cookie: "must-not-leak",
          },
        },
      };
    },
  });
  const status = await service.getStatus({
    loadCredentials: () => ({ cookie: "SESSDATA=private-cookie; bili_jct=private-csrf", csrf: "private-csrf", raw: { secret: true } }),
    credentialsPresent: true,
  });
  assert.deepEqual(status, {
    loggedIn: true,
    authenticated: true,
    credentialsPresent: true,
    health: "ok",
    upstreamAvailable: true,
    stale: false,
    mid: "123456",
    uname: "测试账号",
    face: "https://i0.hdslb.com/bfs/face/account.jpg",
    level: 6,
    vipStatus: 1,
    lastCheckedAt: checkedAt,
    lastSuccessfulAt: checkedAt,
  });
  const serialized = JSON.stringify(status);
  for (const secret of ["private-cookie", "private-csrf", "wbi", "must-not-leak", "current_exp", "raw"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("Bilibili account status distinguishes temporary upstream failure without deleting credentials", async () => {
  const service = createAccountService({
    now: () => new Date("2026-08-31T12:01:00.000Z"),
    request: async () => { throw new Error("getaddrinfo ENOTFOUND api.bilibili.com SESSDATA=secret"); },
  });
  const status = await service.getStatus({
    loadCredentials: () => ({ cookie: "SESSDATA=secret" }),
    credentialsPresent: true,
  });
  assert.equal(status.health, "unavailable");
  assert.equal(status.credentialsPresent, true);
  assert.equal(status.upstreamAvailable, false);
  assert.equal(status.loggedIn, false);
  assert.equal(status.lastSuccessfulAt, null);
  assert.equal(JSON.stringify(status).includes("secret"), false);
});

test("Bilibili account status reports missing credentials without contacting upstream", async () => {
  let requests = 0;
  const service = createAccountService({ request: async () => { requests += 1; } });
  const status = await service.getStatus({ loadCredentials: () => null, credentialsPresent: false });
  assert.equal(status.health, "not_logged_in");
  assert.equal(status.credentialsPresent, false);
  assert.equal(status.upstreamAvailable, null);
  assert.equal(status.loggedIn, false);
  assert.equal(requests, 0);
});

test("Bilibili queue and draft card DTOs retain compatibility while omitting raw paths and payloads", () => {
  const queue = [
    { id: "up_1", recordingId: "rec_1", title: "测试", file: "D:\\private\\recordings\\secret.flv", status: "queued" },
    { id: "up_2", status: "uploading", progress: 48.7 },
    { id: "up_3", status: "failed", error: "Cannot read D:\\private\\recordings\\secret.flv", file: "D:\\private\\recordings\\secret.flv" },
    { id: "up_4", status: "done", draftId: 456, error: "stale failure" },
  ];
  const dto = queue.map(biliQueue.toQueueDto);
  assert.deepEqual(biliQueue.summarizeQueue(queue), { total: 4, queued: 1, waiting_credentials: 0, uploading: 1, failed: 1, done: 1 });
  assert.equal(dto[0].fileName, "secret.flv");
  assert.equal(dto[1].progress, 49);
  assert.equal(dto[2].error, "Cannot read [recording]");
  assert.equal(dto[3].error, "");
  assert.equal(JSON.stringify(dto).includes("D:\\\\private"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dto[0], "file"), false);

  const draft = biliDraft._internals.normalizeDraftItem({
    id: 99,
    title: "草稿卡片",
    cover: "//i0.hdslb.com/bfs/archive/cover.jpg",
    summary: "简介",
    status: 0,
    created: 1788177600,
    modified: 1788177660,
    videos: [{ filename: "private-upos-name" }],
    rawCookie: "SESSDATA=must-not-leak",
  });
  assert.equal(draft.draftId, "99");
  assert.equal(draft.cover, "https://i0.hdslb.com/bfs/archive/cover.jpg");
  assert.equal(draft.videoCount, 1);
  assert.equal(draft.createdAt, "2026-08-31T12:00:00.000Z");
  assert.equal(JSON.stringify(draft).includes("private-upos-name"), false);
  assert.equal(JSON.stringify(draft).includes("must-not-leak"), false);
});

test("recording filenames are safe for Windows and Linux", () => {
  assert.equal(recorder._internals.safeName("a/b:c*?<>|"), "a_b_c_____");
});

test("archive processor names recordings and joins only nearby matching segments", () => {
  const first = {
    id: "part-1",
    memberId: "member-1",
    memberName: "成员一",
    title: "周年快乐",
    startedAt: "2026-09-02T11:16:09.000Z",
    endedAt: "2026-09-02T12:00:00.000Z",
  };
  const second = {
    ...first,
    id: "part-2",
    startedAt: "2026-09-02T12:02:00.000Z",
    endedAt: "2026-09-02T12:30:00.000Z",
  };
  const later = {
    ...first,
    id: "part-3",
    startedAt: "2026-09-02T13:00:00.000Z",
  };
  assert.equal(archiveProcessor._internals.archiveTitle(first), "2026-09-02-成员一-周年快乐");
  assert.deepEqual(
    archiveProcessor._internals.splitSessions([later, second, first], 5 * 60 * 1000).map((items) => items.map((item) => item.id)),
    [["part-1", "part-2"], ["part-3"]]
  );
  assert.equal(archiveProcessor._internals.compatible(first, { ...second, title: "另一场直播" }), false);
});

test("archive processor gives only explicitly linked automatic reconnects a fifteen-minute window", () => {
  const first = {
    id: "auto-part-1", memberId: "member-1", memberName: "成员一", liveId: "live-1",
    autoMonitorId: "member-1", title: "同场", startedAt: "2026-09-02T11:00:00.000Z", endedAt: "2026-09-02T11:00:00.000Z",
  };
  const reconnect = {
    ...first, id: "auto-part-2", startedAt: "2026-09-02T11:12:00.000Z", endedAt: "2026-09-02T11:13:00.000Z", reconnectOf: first.id,
  };
  const unrelated = {
    ...reconnect, id: "auto-part-3", liveId: "live-2", reconnectOf: first.id,
  };
  assert.equal(archiveProcessor._internals.isAutoReconnectPair(first, reconnect), true);
  assert.deepEqual(archiveProcessor._internals.splitSessions([reconnect, first]).map(items => items.map(item => item.id)), [[first.id, reconnect.id]]);
  assert.deepEqual(archiveProcessor._internals.splitSessions([unrelated, first]).map(items => items.map(item => item.id)), [[first.id], [unrelated.id]]);
  assert.equal(archiveProcessor._internals.isAutoReconnectPair(first, { ...reconnect, reconnectOf: undefined }), false);
  assert.equal(archiveProcessor._internals.AUTO_RECONNECT_MERGE_WINDOW_MS, 15 * 60 * 1000);
});

test("automatic recorder persists selected members and leaves finalized segments for the archive processor", async () => {
  const listeners = [];
  const active = new Map();
  const stopped = [];
  const queued = [];
  let lives = [
    { liveId: "live-auto-1", member: { id: "member-1", name: "成员一" } },
    { liveId: "live-auto-2", member: { id: "member-2", name: "成员二" } },
  ];
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: lives }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        const item = { recordingId: `rec-${liveId}`, liveId, ...options };
        active.set(liveId, item);
        return item;
      },
      stop: async (recordingId) => {
        stopped.push(recordingId);
        for (const [liveId, item] of active) if (item.recordingId === recordingId) active.delete(liveId);
      },
      onFinalized: (listener) => listeners.push(listener),
    },
    uploads: { enqueueRecording: (recordingId, options) => queued.push({ recordingId, options }) },
    statfs: () => ({ bavail: 20 * 1024 * 1024, bsize: 1024 }),
  });
  service.setConfig({ enabled: true, pollMs: 10_000, maxConcurrent: 1, missingPollsToStop: 2, members: [{ memberId: "member-1" }, { memberId: "member-2" }] });
  await service.poll();
  assert.equal(active.size, 1);
  assert.equal(service.getStatus().maxConcurrent, 1);
  lives = [];
  await service.poll();
  assert.equal(stopped.length, 0);
  await service.poll();
  assert.equal(stopped.length, 0);
  service._internals.state().lives["live-auto-1"].missingSince = new Date(Date.now() - 301_000).toISOString();
  await service.poll();
  assert.deepEqual(stopped, ["rec-live-auto-1"]);
  listeners[0]({ id: "rec-live-auto-1", autoMonitorId: "member-1", status: "done" });
  listeners[0]({ id: "rec-live-auto-1", autoMonitorId: "member-1", status: "done" });
  assert.deepEqual(queued, []);
  service.stop();
});

test("automatic recorder accepts twenty streams, orders simultaneous lives by priority, and normalizes userInfo ids", async () => {
  const active = new Map(); const starts = [];
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: [
      { liveId: "low", userInfo: { userId: "low-user" } },
      { liveId: "high", member: { id: "high-user" } },
    ] }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir }, listActive: () => [...active.values()],
      start: async (liveId, options) => { starts.push(liveId); const item = { recordingId: `rec-${liveId}`, liveId, ...options }; active.set(liveId, item); return item; },
      stop: async () => {}, onFinalized: () => {},
    }, uploads: { enqueueRecording() {} }, statfs: () => ({ bavail: 20 * 1024 * 1024, bsize: 1024 }),
  });
  service.setConfig({ enabled: true, maxConcurrent: 20, members: [{ memberId: "low-user", priority: 90 }, { memberId: "high-user", priority: 1 }] });
  await service.poll();
  assert.deepEqual(starts, ["high", "low"]);
  assert.equal(service.getStatus().maxConcurrent, 20);
  assert.equal(autoRecorder._internals.MAX_CONCURRENCY, 20);
  service.stop();
});

test("automatic recorder defaults new or incomplete configuration to twenty without rewriting saved values", () => {
  assert.equal(autoRecorder._internals.normalizeConfig({}).maxConcurrent, 20);
  assert.equal(autoRecorder._internals.normalizeConfig({}).missingPollsToStop, 10);
  assert.equal(autoRecorder._internals.normalizeConfig({}).reconnectMaxAttempts, 5);
  assert.equal(autoRecorder._internals.normalizeConfig({}).reconnectBackoffMs, 30_000);
  assert.equal(autoRecorder._internals.normalizeConfig({}).missingGraceMs, 300_000);
  assert.equal(autoRecorder._internals.normalizeConfig({ maxConcurrent: 2 }).maxConcurrent, 2);
  assert.equal(autoRecorder._internals.normalizeConfig({ maxConcurrent: 999 }).maxConcurrent, 20);
});

test("automatic recorder reconnects a failed segment with bounded exponential backoff", async () => {
  const listeners = [];
  const active = new Map();
  const starts = [];
  let sequence = 0;
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: [{ liveId: "live-reconnect", member: { id: "member-reconnect" } }] }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        const item = { recordingId: `rec-reconnect-${++sequence}`, liveId, ...options };
        starts.push(item.recordingId); active.set(item.recordingId, item); return item;
      },
      stop: async () => {},
      onFinalized: listener => listeners.push(listener),
    },
    uploads: { enqueueRecording: () => {} },
    statfs: () => ({ bavail: 20 * 1024 * 1024, bsize: 1024 }),
  });
  service.setConfig({ enabled: true, reconnectMaxAttempts: 2, reconnectBackoffMs: 5_000, members: [{ memberId: "member-reconnect" }] });
  await service.poll();
  assert.deepEqual(starts, ["rec-reconnect-1"]);
  listeners[0]({ id: "rec-reconnect-1", autoMonitorId: "member-reconnect", manualStop: false, status: "waiting_merge" });
  let tracked = service._internals.state().lives["live-reconnect"];
  assert.equal(tracked.reconnectAttempts, 1);
  assert.equal(tracked.reconnectPending, true);
  assert.ok(Date.parse(tracked.nextRetryAt) > Date.now());
  tracked.nextRetryAt = new Date(Date.now() - 1).toISOString();
  await service.poll();
  assert.deepEqual(starts, ["rec-reconnect-1", "rec-reconnect-2"]);
  listeners[0]({ id: "rec-reconnect-2", autoMonitorId: "member-reconnect", manualStop: false, status: "waiting_merge" });
  tracked = service._internals.state().lives["live-reconnect"];
  assert.equal(tracked.reconnectAttempts, 2);
  tracked.nextRetryAt = new Date(Date.now() - 1).toISOString();
  await service.poll();
  assert.deepEqual(starts, ["rec-reconnect-1", "rec-reconnect-2", "rec-reconnect-3"]);
  listeners[0]({ id: "rec-reconnect-3", autoMonitorId: "member-reconnect", manualStop: false, status: "waiting_merge" });
  tracked = service._internals.state().lives["live-reconnect"];
  assert.equal(tracked.reconnectExhausted, true);
  assert.equal(tracked.reconnectPending, false);
  service.stop();
});

test("member catalog joins the official active directory with Pocket48 ids and team filters", async () => {
  const calls = [];
  const requestJson = async (url) => {
    calls.push(url);
    if (url === memberCatalog._internals.ROOM_MAP_URL) return { 成员: "42", 新成员: "43" };
    const groupId = new URL(url).searchParams.get("gid");
    if (groupId === "10") return { rows: [
      { status: "99", sname: "成员", pocket_id: "0", gid: "10", gname: "SNH", tid: "101", tname: "SII" },
      { status: "44", sname: "已离团", pocket_id: "99", gid: "10", gname: "SNH", tid: "101", tname: "SII" },
    ] };
    if (groupId === "20") return { rows: [
      { status: "99", sname: "成员", pocket_id: "42", gid: "20", gname: "BEJ", tid: "201", tname: "B" },
      { status: "99", sname: "新成员", pocket_id: "0", gid: "20", gname: "BEJ", tid: "202", tname: "E" },
    ] };
    return { rows: [] };
  };
  memberCatalog._internals.clearCache();
  try {
    const result = await memberCatalog.listRoster({ force: true, requestJson, requestText: async () => { throw new Error("Member directory HTTP 502"); } });
    assert.equal(calls.length, 1 + memberCatalog._internals.DIRECTORY_IDS.length);
    assert.equal(result.list.length, 2);
    assert.deepEqual(result.list.find(item => item.memberId === "42"), {
      memberId: "42", memberName: "成员", groupId: "10:101", groupName: "SNH48 · Team SII / BEJ48 · Team B",
      groupIds: ["10:101", "20:201"], groupNames: ["SNH48 · Team SII", "BEJ48 · Team B"],
    });
    assert.equal(result.list.some(item => item.memberName === "已离团"), false);
    assert.deepEqual(result.groups.map(group => group.groupId).sort(), ["10:101", "20:201", "20:202"]);
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog resolves an exact name before accepting an unambiguous partial name", () => {
  const list = [
    { memberId: "42", memberName: "陈琳" },
    { memberId: "43", memberName: "陈珂" },
  ];
  assert.equal(memberCatalog.findMemberByName(list, "陈琳").memberId, "42");
  assert.equal(memberCatalog.findMemberByName(list, " 琳 ").memberId, "42");
  assert.equal(memberCatalog.findMemberByName(list, "陈"), null);
  assert.deepEqual(memberCatalog.findMembersByName([
    { memberId: "874717", memberName: "武晓迪" },
    { memberId: "54526095", memberName: "武博涵" },
  ], "武").map((member) => member.memberName), ["武晓迪", "武博涵"]);
});

test("member catalog prefers the official single-payload directory and keeps group and team", async () => {
  const official = 'get_members_success({"total":"3","rows":[' +
    '{"sid":"1","gid":"10","gname":"SNH","sname":"曹可甜","tid":"101","tname":"SII","pocket_id":"1023"},' +
    '{"sid":"2","gid":"20","gname":"BEJ","sname":"黄宣绮","tid":"201","tname":"B","pocket_id":"1024"},' +
    '{"sid":"3","gid":"10","gname":"SNH","sname":"无口袋号","tid":"101","tname":"SII","pocket_id":"0"}' +
    ']})';
  const calls = [];
  const requestText = async (url) => { calls.push(url); return official; };
  const requestJson = async (url) => {
    calls.push(url);
    if (url === memberCatalog._internals.ROOM_MAP_URL) return { 无口袋号: "777" };
    throw new Error("Member directory HTTP 502");
  };
  memberCatalog._internals.clearCache();
  try {
    const result = await memberCatalog.listRoster({ force: true, requestJson, requestText });
    assert.equal(result.source, "official");
    assert.equal(result.fallback, false);
    assert.equal(calls[0], memberCatalog._internals.ROOM_MAP_URL);
    assert.deepEqual(calls.slice(1), [memberCatalog._internals.officialDirectoryUrl()]);
    assert.deepEqual(result.list.map(item => [item.memberName, item.memberId, item.groupName]), [
      ["黄宣绮", "1024", "BEJ48 · Team B"],
      ["曹可甜", "1023", "SNH48 · Team SII"],
      ["无口袋号", "777", "SNH48 · Team SII"],
    ]);
    assert.deepEqual(result.groups.map(group => group.groupName), ["BEJ48 · Team B", "SNH48 · Team SII"]);
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog stays usable when the third-party room map is down", async () => {
  const requestText = async () => 'get_members_success({"rows":[{"gid":"10","gname":"SNH","sname":"曹可甜","tid":"101","tname":"SII","pocket_id":"1023"}]})';
  const requestJson = async () => { throw new Error("room map 502"); };
  memberCatalog._internals.clearCache();
  try {
    const result = await memberCatalog.listRoster({ force: true, requestJson, requestText });
    assert.equal(result.source, "official");
    assert.deepEqual(result.list.map(item => item.memberName), ["曹可甜"]);
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog falls back to the retired per-group directory when the official payload fails", async () => {
  const requestText = async () => { throw new Error("Member directory HTTP 502"); };
  const requestJson = async (url) => {
    if (url === memberCatalog._internals.ROOM_MAP_URL) return {};
    const groupId = new URL(url).searchParams.get("gid");
    if (groupId === "10") return { rows: [{ status: "99", sname: "陈琳", pocket_id: "42", gid: "10", gname: "SNH", tid: "101", tname: "SII" }] };
    return { rows: [] };
  };
  memberCatalog._internals.clearCache();
  try {
    const result = await memberCatalog.listRoster({ force: true, requestJson, requestText });
    assert.equal(result.source, "directory");
    assert.deepEqual(result.list.map(item => [item.memberName, item.groupName]), [["陈琳", "SNH48 · Team SII"]]);
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog falls back to the room map when both directories are down", async () => {
  const requestText = async () => { throw new Error("Member directory HTTP 502"); };
  const requestJson = async (url) => {
    if (url === memberCatalog._internals.ROOM_MAP_URL) return { 陈琳: "42", 熊紫轶: "43", 空: "", 零: "0", 非数字: "abc" };
    throw new Error("Member directory HTTP 502");
  };
  memberCatalog._internals.clearCache();
  try {
    const result = await memberCatalog.listRoster({ force: true, requestJson, requestText });
    assert.equal(result.fallback, true);
    assert.equal(result.source, "room-map");
    assert.deepEqual(result.list.map(item => item.memberName).sort((a, b) => a.localeCompare(b, "zh-CN")), ["熊紫轶", "陈琳"].sort((a, b) => a.localeCompare(b, "zh-CN")));
    assert.deepEqual(result.groups, [{ groupId: "ungrouped", groupName: "未分组" }]);
    assert.equal(memberCatalog.findMemberByName(result.list, "陈琳").memberId, "42");
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog still reports failure when every source is unusable", async () => {
  const requestText = async () => { throw new Error("Member directory HTTP 502"); };
  const requestJson = async (url) => {
    if (url === memberCatalog._internals.ROOM_MAP_URL) return {};
    throw new Error("Member directory HTTP 502");
  };
  memberCatalog._internals.clearCache();
  try {
    await assert.rejects(() => memberCatalog.listRoster({ force: true, requestJson, requestText }), /member directory/i);
  } finally { memberCatalog._internals.clearCache(); }
});

test("member catalog parses JSONP wrappers and rejects malformed payloads", () => {
  const { parseJsonp } = memberCatalog;
  assert.deepEqual(parseJsonp('cb({"rows":[]})'), { rows: [] });
  assert.deepEqual(parseJsonp('  {"rows":[1]}  '), { rows: [1] });
  assert.throws(() => parseJsonp("not json"), /invalid JSON/);
  assert.throws(() => parseJsonp(""), /invalid JSON/);
});

test("uploads pause at a recording boundary and automatically resume without a new queue item", async () => {
  const item = manager.enqueueUpload({ recordingId: "rec-pause", status: "uploading" });
  biliQueue.setRecordingActive(true);
  const waiting = biliQueue._internals.waitForRecordingToFinish(item.id);
  assert.equal(manager.getQueueItem(item.id).status, "paused_recording");
  biliQueue.setRecordingActive(false);
  await waiting;
  assert.equal(manager.getQueueItem(item.id).status, "uploading");
  assert.equal(manager.getQueue().filter((entry) => entry.id === item.id).length, 1);
  manager.dequeueUpload(item.id);
});

test("automatic recorder removes stale restart state and can claim an ongoing live again", async () => {
  const listeners = [];
  const active = new Map();
  let starts = 0;
  const service = autoRecorder.createAutoRecorder({
    live: { listLives: async () => ({ list: [{ liveId: "live-restart", member: { id: "member-restart" } }] }) },
    recorder: {
      _internals: { recordingsDir: () => testDataDir },
      listActive: () => [...active.values()],
      start: async (liveId, options) => {
        starts += 1;
        const item = { recordingId: `rec-restart-${starts}`, liveId, ...options };
        active.set(liveId, item);
        return item;
      },
      stop: async () => {},
      onFinalized: (listener) => listeners.push(listener),
    },
    uploads: { enqueueRecording: () => {} },
    statfs: () => ({ bavail: 20 * 1024 * 1024, bsize: 1024 }),
  });
  service.setConfig({ enabled: true, members: [{ memberId: "member-restart" }] });
  await service.poll();
  assert.equal(starts, 1);
  // This is the process-restart condition: persisted state exists but no child does.
  active.clear();
  await service.poll();
  assert.equal(starts, 2);
  assert.equal(service.getStatus().trackedLives.find(item => item.liveId === "live-restart").recordingId, "rec-restart-2");
  service.stop();
});

test("credential-waiting queue entries resume as queued after a successful login", () => {
  const item = manager.enqueueUpload({ recordingId: "rec-waiting-credentials", status: "waiting_credentials" });
  biliQueue.resumeQueued();
  assert.equal(manager.getQueueItem(item.id).status, "queued");
  manager.dequeueUpload(item.id);
});

test("Bilibili upload queue defaults to one global concurrent upload", () => {
  assert.equal(biliQueue._internals.UPLOAD_CONCURRENCY, 1);
});

test("graceful shutdown is idempotent and saves state before exiting", async () => {
  const calls = [];
  const server = {
    close(callback) { calls.push("server.close"); setImmediate(() => callback()); },
    closeIdleConnections() { calls.push("server.closeIdleConnections"); },
  };
  const controller = createGracefulShutdown({
    server,
    stopRecorders: async () => { calls.push("recorders.stop"); },
    closeEvents: () => { calls.push("events.close"); },
    saveState: () => { calls.push("state.save"); },
    exit: (code) => { calls.push(`exit:${code}`); },
    logger: { log() {}, error() {} },
    timeoutMs: 1000,
  });
  const first = controller.shutdown("SIGTERM");
  const second = controller.shutdown("SIGINT");
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(result, { outcome: "complete", exitCode: 0 });
  assert.equal(calls.filter((item) => item === "server.close").length, 1);
  assert.ok(calls.indexOf("recorders.stop") < calls.indexOf("state.save"));
  assert.equal(calls.at(-1), "exit:0");
});
