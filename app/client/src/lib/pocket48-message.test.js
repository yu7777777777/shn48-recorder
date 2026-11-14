import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage } from './pocket48-message.js';

test('empty body live notifications use extInfo title and sender', () => {
  assert.deepEqual(formatMessage({ msgType: 'TEXT', bodys: '', extInfo: JSON.stringify({ messageType: 'LIVEPUSH', liveTitle: 'Hi！', user: { nickName: 'SNH48-陈琳' } }) }), { senderName: 'SNH48-陈琳', text: '直播通知：Hi！' });
});
test('text bodies, empty fields, replies and malformed metadata never render blank', () => {
  assert.equal(formatMessage({ bodys: '{"text":"你好"}' }).text, '你好');
  assert.equal(formatMessage({ bodys: '', msgContent: '正文' }).text, '正文');
  assert.equal(formatMessage({ bodys: '{"replyInfo":{"text":"回复"}}' }).text, '回复');
  assert.equal(formatMessage({ bodys: '   ', extInfo: '{bad' }).text, '[暂不支持显示的消息类型]');
  assert.equal(formatMessage({ bodys: '', extInfo: '{"messageType":"AUDIO"}' }).text, '[语音消息]');
});
test('chat media uses safe web URLs and actual sender names', () => {
  const msg = { msgType: 'IMAGE', bodys: JSON.stringify({ url: 'https://example.com/image.jpg' }), extInfo: JSON.stringify({ user: { nickName: '成员昵称' } }) };
  assert.equal(formatMessage(msg).mediaType, 'image');
  assert.equal(formatMessage(msg).senderName, '成员昵称');
  assert.equal(formatMessage({ ...msg, bodys: '{"url":"javascript:alert(1)"}' }).mediaUrl, undefined);
});
