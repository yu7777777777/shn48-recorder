import test from 'node:test';
import assert from 'node:assert/strict';
import { adminApi } from './api.js';

// 401 域契约：只有「管理员会话失效」的 401 才弹去登录页。第三方凭据的
// 拒绝（口袋48 / B站）与登录失败都会带各自的 errorCode，无论路径与方法
// 是什么，都必须留给页面自己处理——否则 /admin/bilibili 等页面会在
// 「401 → 登录页 → 已登录 → 弹回」之间死循环。
test('only 401s without a non-session errorCode bounce the administrator to login', async () => {
  const before = globalThis.window;
  const redirects = [];
  globalThis.window = {
    location: { pathname: '/admin/auto-record', search: '?login=1', assign: value => redirects.push(value) },
    setTimeout: fn => fn(),
  };
  const reject = adminApi.interceptors.response.handlers[0].rejected;
  const error = (url, method = 'post', errorCode = 'POCKET48_LOGIN_REJECTED', status = 401) => ({
    config: { url, method },
    response: { status, data: { errorCode } },
  });
  try {
    // 凭据域 401：任何路径与方法都不弹登录。
    const nonSession = [
      error('/pocket48/login'),
      error('/pocket48/login/sms/verify'),
      error('/api/admin/pocket48/token'),
      error('/pocket48/token', 'get'),
      error('/pocket48/token/other', 'post'),
      error('/other?next=/pocket48/token', 'post'),
      error('/bilibili/drafts', 'get', 'BILIBILI_LOGIN_REQUIRED'),
      error('/recordings/r1/upload', 'post', 'BILIBILI_LOGIN_REQUIRED'),
      error('/auth/login', 'post', 'ADMIN_LOGIN_FAILED'),
    ];
    for (const e of nonSession) {
      await assert.rejects(reject(e), r => r === e);
      assert.equal(redirects.length, 0, e.config.url);
    }

    // 会话探针的预期 401 也不是过期。
    const probe = error('/auth/session', 'get', undefined);
    await assert.rejects(reject(probe), r => r === probe);
    assert.equal(redirects.length, 0);

    // 无 errorCode 的 401 仍然视为会话失效，弹去登录并携带回跳地址。
    const expired1 = error('/config', 'post', null);
    const expired2 = error('/recordings', 'get', null);
    await assert.rejects(reject(expired1), r => r === expired1);
    assert.equal(redirects.length, 1);
    assert.equal(redirects[0], '/admin/login?redirect=%2Fadmin%2Fauto-record%3Flogin%3D1');
    await assert.rejects(reject(expired2), r => r === expired2);
    assert.equal(redirects.length, 2);

    // 非 401 与会话探针不弹。
    const serverError = error('/pocket48/token', 'post', undefined, 502);
    const probeAgain = error('/auth/session', 'get', null);
    await assert.rejects(reject(serverError), r => r === serverError);
    await assert.rejects(reject(probeAgain), r => r === probeAgain);
    assert.equal(redirects.length, 2);
  } finally {
    if (before === undefined) delete globalThis.window;
    else globalThis.window = before;
  }
});
