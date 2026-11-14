"use strict";

const biliDraft = require("./draft");

const DEFAULT_NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const ALLOWED_IMAGE_HOST_SUFFIXES = [".hdslb.com", ".biliimg.com", ".bilibili.com"];

function boundedString(value, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeImageUrl(value) {
  const raw = boundedString(value, 2048);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return "";
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") return "";
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return "";
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function finiteInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function emptyProfile() {
  return { mid: "", uname: "", face: "", level: null, vipStatus: null };
}

function profileFromNav(data) {
  const levelInfo = data && typeof data.level_info === "object" ? data.level_info : {};
  const mid = finiteInteger(data && data.mid, { min: 1 });
  return {
    mid: mid === null ? "" : String(mid),
    uname: boundedString(data && data.uname, 80),
    face: safeImageUrl(data && data.face),
    level: finiteInteger(levelInfo.current_level, { min: 0, max: 6 }),
    vipStatus: finiteInteger(data && data.vipStatus, { min: 0, max: 10 }),
  };
}

function createAccountService(options = {}) {
  const request = options.request || biliDraft._internals.request;
  const now = options.now || (() => new Date());
  const navUrl = options.navUrl || process.env.BILI_NAV_URL || DEFAULT_NAV_URL;
  let lastKnown = null;
  let lastSuccessfulAt = null;

  function timestamp() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function base({ health, credentialsPresent, upstreamAvailable, loggedIn, profile, stale = false }) {
    return {
      loggedIn,
      authenticated: loggedIn,
      credentialsPresent,
      health,
      upstreamAvailable,
      stale,
      ...(profile || emptyProfile()),
      lastCheckedAt: timestamp(),
      lastSuccessfulAt,
    };
  }

  async function getStatus({ loadCredentials, credentialsPresent = false }) {
    let credentials;
    try {
      credentials = loadCredentials();
    } catch {
      return base({
        health: "credentials_error",
        credentialsPresent: Boolean(credentialsPresent),
        upstreamAvailable: null,
        loggedIn: false,
      });
    }
    if (!credentials || !credentials.cookie) {
      return base({
        health: "not_logged_in",
        credentialsPresent: false,
        upstreamAvailable: null,
        loggedIn: false,
      });
    }

    try {
      const response = await request("GET", navUrl, {
        headers: {
          Cookie: credentials.cookie,
          Referer: "https://www.bilibili.com/",
        },
        timeoutMs: 20_000,
      });
      const json = response && response.json;
      const data = json && json.data;
      if (response.status !== 200 || !json || typeof json !== "object") {
        throw new Error("Bilibili nav is temporarily unavailable");
      }
      if (Number(json.code) === -101 || (Number(json.code) === 0 && data && data.isLogin === false)) {
        return base({
          health: "not_logged_in",
          credentialsPresent: true,
          upstreamAvailable: true,
          loggedIn: false,
        });
      }
      if (Number(json.code) !== 0 || !data || data.isLogin !== true) {
        throw new Error("Unexpected Bilibili nav response");
      }
      const profile = profileFromNav(data);
      lastKnown = profile;
      lastSuccessfulAt = timestamp();
      return base({
        health: "ok",
        credentialsPresent: true,
        upstreamAvailable: true,
        loggedIn: true,
        profile,
      });
    } catch {
      return base({
        health: "unavailable",
        credentialsPresent: true,
        upstreamAvailable: false,
        loggedIn: false,
        profile: lastKnown,
        stale: Boolean(lastKnown),
      });
    }
  }

  function clearCache() {
    lastKnown = null;
    lastSuccessfulAt = null;
  }

  return { getStatus, clearCache };
}

const accountService = createAccountService();

module.exports = {
  accountService,
  createAccountService,
  _internals: { profileFromNav, safeImageUrl },
};
