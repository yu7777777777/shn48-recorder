const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const api = require('./api');
const account = require('./account');
const store = require('../../lib/store');
const file = path.join(process.env.POCKET48_DATA_DIR || process.env.DATA_DIR || path.dirname(api._internals.TOKEN_PATH), 'auto-checkin.json');
let state = { enabled: false, start: '09:00', end: '11:00', userId: '', nextAt: null, lastDate: '', lastResult: '' };
try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
let busy = false, timer;
function save() { store.atomicWrite(file, state); }
function day(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
function plan(now = Date.now()) {
  let date = day(now);
  let start = Date.parse(`${date}T${state.start}:00+08:00`), end = Date.parse(`${date}T${state.end}:00+08:00`);
  if (state.lastDate === date || now >= end) { date = day(now + 86400000); start = Date.parse(`${date}T${state.start}:00+08:00`); end = Date.parse(`${date}T${state.end}:00+08:00`); }
  const lower = Math.max(start, now);
  state.nextAt = lower + crypto.randomInt(Math.max(1, end - lower));
}
function status() { return { ...state, running: busy }; }
function configure(value) {
  if (busy) throw Object.assign(new Error('签到执行中，请稍后修改'), { status: 409 });
  if (typeof value.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end) || value.start >= value.end) throw Object.assign(new Error('请设置同一天内有效的开始和结束时间'), { status: 400 });
  const userId = api.getToken()?.userId;
  if (value.enabled && !userId) throw Object.assign(new Error('请先登录口袋48账号'), { status: 409 });
  state = { ...state, enabled: value.enabled, start: value.start, end: value.end, userId: String(userId || state.userId), nextAt: null };
  // A stale "已暂停：…" line would otherwise sit next to a freshly checked
  // "每天自动签到" box and contradict it — the old failure is superseded by the
  // fact that the user just re-armed the schedule.
  if (state.enabled && /^已暂停/.test(state.lastResult)) state.lastResult = '';
  if (state.enabled) plan();
  save(); return status();
}
async function tick() {
  if (!state.enabled || busy) return;
  if (!state.nextAt) { plan(); save(); }
  const now = Date.now();
  if (now < state.nextAt) return;
  busy = true;
  // Captured so a failed attempt can be rolled back. Without this the attempt
  // mark stayed on today's date, and re-enabling auto check-in the same day
  // silently skipped it (the `lastDate === day(now)` guard below).
  const previousDate = state.lastDate;
  try {
    const token = api.getToken();
    if (!token || String(token.userId) !== state.userId) throw new Error('登录账号已变化或失效，请重新登录并启用自动签到');
    const end = Date.parse(`${day(now)}T${state.end}:00+08:00`);
    if (day(state.nextAt) !== day(now) || now >= end || state.lastDate === day(now)) { plan(now); save(); return; }
    // Persist attempt before network requests to prevent duplicate writes after restart.
    state.lastDate = day(now); state.lastResult = '正在检查'; save();
    const info = account.content(await api.getCheckinInfo());
    const checked = ['hasCheck','isCheckin','checked','isCheckIn'].some(k => info[k] === true || info[k] === 1);
    if (api.getToken()?.token !== token.token) throw new Error('账号已切换，自动签到已暂停');
    if (!checked) account.content(await api.doCheckin());
    state.lastResult = checked ? '今日已签到，自动跳过' : '自动签到成功';
    plan(); save();
  } catch (e) {
    // Roll back the attempt mark so the user can retry the same day after
    // fixing the cause (for example re-logging in).
    state.lastDate = previousDate;
    state.enabled = false; state.nextAt = null; state.lastResult = `已暂停：${e.message}`; save();
  }
  finally { busy = false; }
}
function start() { if (timer) return; timer = setInterval(() => { tick().catch(()=>{}); }, 30000); timer.unref?.(); tick().catch(()=>{}); }
function stop() { clearInterval(timer); timer = null; }
module.exports = { status, configure, start, stop, tick };
