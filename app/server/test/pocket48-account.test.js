const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../modules/pocket48/api');
const account = require('../modules/pocket48/account');
test('reject upstream business errors and redact profile credentials', async () => {
  assert.throws(() => account.content({ status: 200, data: { status: 1001, content: {} } }));
  assert.throws(() => account.roomId('../1'));
  const original = api.getUserInfo;
  api.getUserInfo = async () => ({ status: 200, data: { status: 200, content: { userInfo: { nickname: '测试', userId: '42', token: 'secret', mobile: 'secret' } } } });
  try { const profile = await account.profile(); assert.equal(profile.nickname, '测试'); assert.equal(profile.token, undefined); assert.equal(profile.mobile, undefined); }
  finally { api.getUserInfo = original; }
});
test('account routes reject missing credentials and invalid room ids', async () => {
  const express = require('express'); const app = express(); app.use(express.json()); app.use(require('../routes/pocket48-account'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`; const original = api.getToken;
  try {
    api.getToken = () => null; assert.equal((await fetch(`${url}/profile`)).status, 409);
    api.getToken = () => ({ token: 'test' }); assert.equal((await fetch(`${url}/rooms/invalid/messages`)).status, 400);
  } finally { api.getToken = original; await new Promise(resolve => server.close(resolve)); }
});

// Following and unfollowing write to the Pocket48 account itself. These must
// send `toType: 1` alongside the member id, or the upstream API answers
// "缺少请求参数" — the exact failure observed against the live service.
test('follow endpoints mutate the account follow list through the friendship API', async () => {
  const express = require('express'); const app = express(); app.use(express.json()); app.use(require('../routes/pocket48'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const directory = require('../modules/pocket48/room-directory');
  const original = { token: api.getToken, follow: api.followMember, unfollow: api.unfollowMember, ids: api.getFollowedIds, roster: directory.roster };
  api.getToken = () => ({ token: 'test-only' });
  // The directory is a public read over the network; stub it so the test stays
  // offline. It mirrors the real shape: already-followed AND not-yet-followed.
  directory.roster = async () => ([
    { teamName: 'TEAM X', members: [{ ownerId: '2001', ownerName: 'SNH48-王睿琦', roomId: '67362328', groupName: 'SNH48' }] },
    { teamName: '', members: [{ ownerId: '63', ownerName: '袋王', roomId: '67236601', groupName: '官方' }] },
    { teamName: 'TEAM NII', members: [{ ownerId: '2002', ownerName: 'SNH48-杨宇馨', roomId: '67275547', groupName: 'SNH48' }] },
  ]);
  const seen = [];
  api.followMember = async ownerId => { seen.push(['add', String(ownerId)]); return { status: 200, data: { status: 200, success: true } }; };
  api.unfollowMember = async ownerId => { seen.push(['remove', String(ownerId)]); return { status: 200, data: { status: 200, success: true } }; };
  api.getFollowedIds = async () => ({ status: 200, data: { status: 200, success: true, content: { data: [63, 2001] } } });
  const call = async (path, init) => { const res = await fetch(url + path, init); return { status: res.status, body: await res.json() }; };
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const added = await call('/friendships/followed', json({ ownerId: '2002' }));
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.data, { ownerId: '2002', followed: true });
    assert.deepEqual(seen.at(-1), ['add', '2002']);

    const removed = await call('/friendships/followed/2001', { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(seen.at(-1), ['remove', '2001']);

    // A non-numeric id must be refused before it reaches the account.
    assert.equal((await call('/friendships/followed', json({ ownerId: '../1' }))).status, 400);
    assert.equal((await call('/friendships/followed/nope', { method: 'DELETE' })).status, 400);

    // Without a token these must stop at the guard. Otherwise the request would
    // be sent to Pocket48 anonymously and surface as "缺少请求参数".
    api.getToken = () => null;
    const before = seen.length;
    assert.equal((await call('/friendships/followed', json({ ownerId: '2002' }))).status, 409);
    assert.equal((await call('/friendships/followed/2001', { method: 'DELETE' })).status, 409);
    assert.equal((await call('/friendships/followed')).status, 409);
    assert.equal((await call('/friendships/roster')).status, 409);
    assert.equal(seen.length, before, '未登录时不发出任何关注请求');
    api.getToken = () => ({ token: 'test-only' });

    const followed = await call('/friendships/followed');
    assert.deepEqual(followed.body.data.ownerIds, ['63', '2001']);

    // The roster is what makes ADDING possible: it must contain members the
    // account does NOT follow, flagged as such.
    const roster = await call('/friendships/roster');
    assert.equal(roster.status, 200);
    assert.equal(roster.body.data.followedCount, 2);
    const flat = roster.body.data.groups.flatMap(g => g.members);
    assert.ok(flat.some(m => m.followed), '名单包含已关注成员');
    assert.ok(flat.some(m => !m.followed), '名单包含未关注成员，可用于新增关注');
  } finally {
    api.getToken = original.token; api.followMember = original.follow; api.unfollowMember = original.unfollow;
    api.getFollowedIds = original.ids; directory.roster = original.roster;
    await new Promise(resolve => server.close(resolve));
  }
});

test('linked account DTO removes credentials and switch rejects unrelated users', async () => {
  const original = { info: api.getUserInfo, token: api.getToken, switch: api.switchLinkedAccount };
  let calls = 0;
  api.getToken = () => ({ token: 'test-only' });
  api.getUserInfo = async () => ({ status: 200, data: { status: 200, content: { userId: 1, nickname: '主号', bigSmallInfo: { bigUserInfo: { userId: 1, nickname: '主号', token: 'hidden' }, smallUserInfo: [{ userId: 2, nickname: '小号', mobile: 'hidden' }] } } } });
  api.switchLinkedAccount = async (id, token) => { calls++; assert.equal(id, '2'); assert.equal(token, 'test-only'); return { authenticated: true }; };
  try {
    const p = await account.profile(); assert.equal(p.accounts.length, 2); assert.equal(p.accounts[1].kind, 'small'); assert.equal(p.accounts[0].token, undefined); assert.equal(p.accounts[1].mobile, undefined);
    await assert.rejects(account.switchAccount('999'), /不属于/); assert.equal(calls, 0);
    await account.switchAccount('1'); assert.equal(calls, 0);
    await account.switchAccount('2'); assert.equal(calls, 1);
  } finally { api.getUserInfo = original.info; api.getToken = original.token; api.switchLinkedAccount = original.switch; }
});
