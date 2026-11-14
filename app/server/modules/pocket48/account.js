"use strict";
const api = require('./api');

function content(result) {
  if (result?.status !== 200 || result?.data?.status !== 200) {
    const code = Number(result?.data?.status || result?.status) || 0;
    const reason = result?.status === 404 ? '口袋48接口不存在（404），请联系管理员更新接口' : [401, 403].includes(code) ? '口袋48拒绝访问，请刷新账号状态检查权限' : `口袋48请求失败（HTTP ${result?.status || '未知'}，业务码 ${code}），请稍后重试`;
    const error = new Error(reason);
    error.status = 502;
    throw error;
  }
  return result.data.content || {};
}
function roomId(value) {
  if (!/^\d{1,30}$/.test(String(value || ''))) {
    const error = new Error('请输入有效的数字房间 ID'); error.status = 400; throw error;
  }
  return String(value);
}
function messages(value) {
  return Array.isArray(value.message) ? value.message : Array.isArray(value.messages) ? value.messages : Array.isArray(value.list) ? value.list : [];
}
async function profile() {
  const data = content(await api.getUserInfo());
  const user = data.userInfo || data.user || data;
  // Only expose fields needed by the console, never upstream credentials.
  const userId = String(user.userId || user.id || '');
  const linked = data.bigSmallInfo || user.bigSmallInfo || {};
  const accounts = [linked.bigUserInfo && { ...linked.bigUserInfo, kind: 'main' }, ...(Array.isArray(linked.smallUserInfo) ? linked.smallUserInfo.map(item => ({ ...item, kind: 'small' })) : [])]
    .filter(item => item && /^\d+$/.test(String(item.userId)))
    .map(item => ({ userId: String(item.userId), nickname: item.nickname || '', avatar: item.avatar || '', kind: item.kind, current: String(item.userId) === userId }));
  return { userId, nickname: user.nickname || user.userName || '', avatar: user.avatar || '', level: user.level ?? null, signature: user.signature || '', accounts };
}
let switching = false;
async function switchAccount(id) {
  if (!/^\d{1,30}$/.test(String(id || ''))) throw Object.assign(new Error('请选择有效账号'), { status: 400 });
  if (switching) throw Object.assign(new Error('正在切换账号，请稍候'), { status: 409 });
  switching = true;
  try {
    const token = api.getToken()?.token;
    const current = await profile();
    if (!current.accounts.some(item => item.userId === String(id))) throw Object.assign(new Error('目标账号不属于当前主号／小号列表'), { status: 400 });
    if (String(id) === current.userId) return api.publicTokenInfo();
    const result = await api.switchLinkedAccount(String(id), token);
    return result;
  } finally { switching = false; }
}
module.exports = { content, roomId, messages, profile, switchAccount };
