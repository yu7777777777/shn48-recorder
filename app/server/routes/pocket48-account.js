"use strict";
// Mounted at /api/admin/pocket48/account by routes/pocket48.js.
//
// This router owns the account-scoped reads: profile, linked-account switch,
// check-in and per-room message history. Following and unfollowing lives in
// routes/pocket48.js under /friendships because it is a mutation of the
// Pocket48 account rather than a local subscription.
const router = require('express').Router();
const api = require('../modules/pocket48/api');
const account = require('../modules/pocket48/account');
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 502).json({ success: false, error: error.status ? error.message : '口袋48服务暂不可用，请稍后重试' }); }
};
router.get('/auto-checkin', handle(() => require('../modules/pocket48/auto-checkin').status()));
router.put('/auto-checkin', handle(req => require('../modules/pocket48/auto-checkin').configure(req.body)));
router.get('/replay-watch', handle(() => require('../modules/pocket48/replay-watch').status()));
router.put('/replay-watch', handle(req => require('../modules/pocket48/replay-watch').configure(req.body)));
// Manual run, so an operator never has to wait for the daily timer. `force`
// skips the 24h gate without shifting the recorded attempt time; the tick
// contract ({ queued, upstreamError }) is flattened next to the watch status so
// the frontend can tell "nothing new" from "Pocket48 unreachable".
router.post('/replay-watch/run', handle(async () => {
  const watch = require('../modules/pocket48/replay-watch');
  const tickResult = await watch.tick(Date.now(), { force: true });
  return { ...watch.status(), ...tickResult };
}));
router.use((req, res, next) => {
  if (!api.getToken()) return res.status(409).json({ success: false, error: '请先登录口袋48账号' });
  next();
});
router.get('/profile', handle(account.profile));
router.post('/switch', handle(req => account.switchAccount(req.body?.userId)));
router.get('/checkin', handle(async () => account.content(await api.getCheckinInfo())));
router.post('/checkin', handle(async () => account.content(await api.doCheckin())));
router.get('/rooms', handle(async () => account.content(await api.getRoomList())));
router.get('/rooms/:id/messages', handle(async req => {
  const nextTime = req.query.nextTime;
  if (nextTime && !/^\d{1,30}$/.test(nextTime)) { const e = new Error('消息分页参数无效'); e.status = 400; throw e; }
  return account.content(await api.getRoomMessages(account.roomId(req.params.id), nextTime, req.query.scope || 'members'));
}));
// Read-only diagnosis for a room that shows nothing: asks every known message
// endpoint the same question and reports which ones answered with rows. It is
// separate from the transcript so the normal read path stays single-source.
router.get('/rooms/:id/diagnose', handle(async req => {
  const nextTime = req.query.nextTime;
  if (nextTime && !/^\d{1,30}$/.test(nextTime)) { const e = new Error('消息分页参数无效'); e.status = 400; throw e; }
  return api.probeRoomMessages(account.roomId(req.params.id), nextTime);
}));
module.exports = router;
