function parse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function text(value) {
  const data = parse(value);
  if (typeof data === 'string') return data.trim();
  if (!data || typeof data !== 'object') return '';
  return [data.text, data.content, data.replyInfo?.text, data.answer, data.title]
    .find(item => typeof item === 'string' && item.trim()) || '';
}
export function formatMessage(msg) {
  const parsed = parse(msg.extInfo);
  const ext = parsed && typeof parsed === 'object' ? parsed : {};
  const type = String(ext.messageType || ext.messageObject || msg.messageType || msg.msgType || '').toUpperCase();
  const senderName = msg.senderName || ext.user?.nickName || ext.user?.nickname || msg._ownerName || '房间用户';
  const body = [msg.bodys, msg.body, msg.content, msg.text, msg.msgContent].map(text).find(Boolean);
  const bodyData = parse(msg.bodys);
  if (type.startsWith('FLIPCARD')) {
    const info = ext.filpCardInfo || ext.flipCardInfo || bodyData?.filpCardInfo || ext;
    const answer = parse(info.answer);
    const mediaUrl = typeof answer === 'object' ? answer?.url : answer;
    const mediaType = type === 'FLIPCARD_AUDIO' || String(info.answerType) === '2' ? 'audio' : type === 'FLIPCARD_VIDEO' || String(info.answerType) === '3' ? 'video' : null;
    const result = { senderName, label: '偶像翻牌', question: typeof info.question === 'string' ? info.question : '', text: mediaType ? '成员回复：' : (text(info.answer) || '这条翻牌未返回回复内容') };
    if (mediaType && typeof mediaUrl === 'string' && /^https?:\/\//i.test(mediaUrl)) return { ...result, mediaType, mediaUrl };
    return result;
  }

  const mediaType = { IMAGE: 'image', EXPRESSIMAGE: 'image', AUDIO: 'audio', VIDEO: 'video' }[type];
  const rawUrl = bodyData?.url || ext.url || msg.msgContent;
  if (mediaType && typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl)) {
    return { senderName, text: body || '', mediaType, mediaUrl: rawUrl };
  }
  if (type === 'LIVEPUSH' || type === 'OPEN_LIVE') {
    return { senderName, text: `直播通知：${ext.liveTitle || body || '成员开启了直播'}` };
  }
  const labels = { IMAGE: '图片消息', EXPRESSIMAGE: '表情消息', AUDIO: '语音消息', VIDEO: '视频消息', DELETE: '消息已撤回' };
  return { senderName, text: body || text(ext) || `[${labels[type] || '暂不支持显示的消息类型'}]` };
}

export function isMemberMessage(msg, ownerId) {
  const ext = parse(msg.extInfo);
  const senderId = msg.senderId || ext?.user?.userId;
  return Boolean(ownerId && senderId && String(ownerId) === String(senderId)) || Number(ext?.user?.roleId) === 3;
}
