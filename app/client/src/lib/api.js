import axios from "axios";

export const publicApi = axios.create({
  baseURL: "/api/public",
  withCredentials: false,
  timeout: 15000,
});

export const adminApi = axios.create({
  baseURL: "/api/admin",
  withCredentials: true,
  timeout: 20000,
});

// A rejected request is the only place an ended session becomes observable.
// Without this the admin console stayed mounted and kept polling after the
// session expired: every request 401'd, the user saw a stream of error toasts
// and never reached the login screen. Redirect once and let the caller's own
// error handling still run.
let redirecting = false;

// 401 不等于管理员会话失效：B站/口袋48 凭据缺失也会以 401 返回（带各自的
// errorCode）。只有会话中间件与登录接口的 401 才应该把页面弹去登录；
// 第三方凭据的 401 留给页面自己展示（如提示扫码绑定），否则会在
// /admin/bilibili 等页面形成「401 → 登录页 → 已登录 → 弹回」的死循环。
const NON_SESSION_401_CODES = new Set([
  "POCKET48_LOGIN_REJECTED",
  "BILIBILI_LOGIN_REQUIRED",
  "ADMIN_LOGIN_FAILED",
]);

adminApi.interceptors.response.use(
  response => response,
  error => {
    const status = error?.response?.status;
    const url = String(error?.config?.url || "");
    // The session probe is expected to 401 for a signed-out visitor; that is a
    // normal answer, not an expiry, so it must not bounce the page.
    const isSessionProbe = url.includes("/auth/session");
    const errorCode = error?.response?.data?.errorCode;

    if (
      status === 401
      && !isSessionProbe
      && !NON_SESSION_401_CODES.has(errorCode)
      && !redirecting
      && typeof window !== "undefined"
    ) {
      redirecting = true;
      const here = window.location.pathname + window.location.search;
      window.setTimeout(() => {
        redirecting = false;
        if (window.location.pathname !== "/admin/login") {
          window.location.assign(`/admin/login?redirect=${encodeURIComponent(here)}`);
        }
      }, 0);
    }
    return Promise.reject(error);
  }
);

export function payload(response, fallback = null) {
  const body = response?.data;
  if (body && Object.prototype.hasOwnProperty.call(body, "data")) return body.data;
  return body ?? fallback;
}

export function listPayload(response, keys = []) {
  const body = payload(response, []);
  if (Array.isArray(body)) return body;
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  const nested = body?.content || body?.data;
  if (Array.isArray(nested)) return nested;
  for (const key of keys) {
    if (Array.isArray(nested?.[key])) return nested[key];
  }
  return [];
}

// Axios failure codes carry no useful Chinese text ("Network Error",
// "timeout of 20000ms exceeded"); map the common ones before the raw
// error.message fallback. Server-provided error fields keep priority.
const ERROR_CODE_MESSAGES = {
  ECONNABORTED: "请求超时，请稍后重试",
  ERR_NETWORK: "网络连接失败，请检查网络后重试",
};

export function errorMessage(error, fallback = "请求失败，请稍后重试") {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || ERROR_CODE_MESSAGES[error?.code]
    || error?.message
    || fallback;
}
