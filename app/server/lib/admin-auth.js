"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE_NAME = "shn48_admin";
const SESSION_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.SESSION_TTL_MS) || 12 * 60 * 60 * 1000);
const SCRYPT_KEY_LENGTH = 64;
const REMEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function digest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
}

function constantTimeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derivedKey = crypto.scryptSync(String(password), salt, SCRYPT_KEY_LENGTH);
  return { algorithm: "scrypt", salt: salt.toString("base64"), hash: derivedKey.toString("base64") };
}

function decodeCanonicalBase64(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedLength || decoded.toString("base64") !== value) return null;
  return decoded;
}

function validateStoredRecord(value) {
  if (!value || value.version !== 1 || typeof value.username !== "string") return null;
  const password = value.password;
  if (!password || password.algorithm !== "scrypt") return null;
  const salt = decodeCanonicalBase64(password.salt, 16);
  const hash = decodeCanonicalBase64(password.hash, SCRYPT_KEY_LENGTH);
  if (!salt || !hash) return null;
  return { version: 1, username: value.username, password: { algorithm: "scrypt", salt, hash } };
}

function validateUsername(username) {
  if (typeof username !== "string") return "New username is required";
  if (username !== username.trim()) return "Username cannot start or end with whitespace";
  if (username.length < 3 || username.length > 64) return "Username must be 3 to 64 characters";
  if (/\s|[\u0000-\u001f\u007f]/u.test(username)) return "Username cannot contain whitespace or control characters";
  return null;
}

function validatePassword(password, username) {
  if (typeof password !== "string") return "New password is required";
  if (password.length < 10 || password.length > 256) return "Password must be 10 to 256 characters";
  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password)];
  if (categories.filter(Boolean).length < 2) return "Password must contain at least two character types";
  if (constantTimeEqual(password, username)) return "Password cannot be the same as the username";
  return null;
}

function createCredentialStore({
  filePath = process.env.ADMIN_CREDENTIALS_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, "..", "runtime"), "admin-credentials.json"),
  environment = process.env,
} = {}) {
  let loaded = false;
  let persisted = null;

  function load() {
    if (loaded) return persisted;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      persisted = validateStoredRecord(parsed);
      if (!persisted) throw new Error("Invalid administrator credential store");
      return persisted;
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      loaded = false;
      throw error;
    }
  }

  function currentUsername() {
    const record = load();
    return record ? record.username : String(environment.ADMIN_USERNAME || "");
  }

  function hasCredentials() {
    try {
      const record = load();
      return record ? Boolean(record.username) : Boolean(environment.ADMIN_USERNAME && environment.ADMIN_PASSWORD);
    } catch {
      return false;
    }
  }

  function verifyPassword(password) {
    if (typeof password !== "string") return false;
    const record = load();
    if (!record) return Boolean(environment.ADMIN_PASSWORD) && constantTimeEqual(password, environment.ADMIN_PASSWORD);
    const derivedKey = crypto.scryptSync(password, record.password.salt, record.password.hash.length);
    return crypto.timingSafeEqual(derivedKey, record.password.hash);
  }

  function verify(username, password) {
    if (!hasCredentials()) return false;
    let passwordOk = false;
    try { passwordOk = verifyPassword(password); } catch { passwordOk = false; }
    return constantTimeEqual(username, currentUsername()) && passwordOk;
  }

  function persist(record) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = `${JSON.stringify({
      version: 1,
      username: record.username,
      password: {
        algorithm: "scrypt",
        salt: record.password.salt.toString("base64"),
        hash: record.password.hash.toString("base64"),
      },
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let handle;
    try {
      handle = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(handle, serialized, "utf8");
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(temporaryPath, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (handle !== undefined && handle !== null) {
        try { fs.closeSync(handle); } catch {}
      }
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }

  function update({ currentPassword, newUsername, newPassword }) {
    if (typeof currentPassword !== "string" || currentPassword.length === 0 || currentPassword.length > 512) {
      return { ok: false, status: 400, error: "Current password is required" };
    }
    if (!verifyPassword(currentPassword)) return { ok: false, status: 401, error: "Current password is incorrect" };
    if (newUsername === undefined && newPassword === undefined) {
      return { ok: false, status: 400, error: "Provide a new username or password" };
    }

    const previousUsername = currentUsername();
    const username = newUsername === undefined ? previousUsername : newUsername;
    const usernameError = validateUsername(username);
    if (usernameError) return { ok: false, status: 400, error: usernameError };
    if (newPassword !== undefined) {
      const passwordError = validatePassword(newPassword, username);
      if (passwordError) return { ok: false, status: 400, error: passwordError };
      if (verifyPassword(newPassword)) return { ok: false, status: 400, error: "New password must be different from the current password" };
    }
    if (newUsername !== undefined && constantTimeEqual(newUsername, previousUsername) && newPassword === undefined) {
      return { ok: false, status: 400, error: "Administrator credentials are unchanged" };
    }

    const hashed = hashPassword(newPassword === undefined ? currentPassword : newPassword);
    const record = {
      version: 1,
      username,
      password: {
        algorithm: hashed.algorithm,
        salt: Buffer.from(hashed.salt, "base64"),
        hash: Buffer.from(hashed.hash, "base64"),
      },
    };
    persist(record);
    persisted = record;
    loaded = true;
    return { ok: true };
  }

  function sessionScope() {
    const record = load();
    const material = record ? [record.username, record.password.salt.toString("base64"), record.password.hash.toString("base64")]
      : [environment.ADMIN_USERNAME || "", environment.ADMIN_PASSWORD || ""];
    return crypto.createHmac("sha256", environment.SESSION_SECRET || "not-configured").update(JSON.stringify(material)).digest("hex");
  }
  return { filePath, currentUsername, hasCredentials, verifyPassword, verify, update, sessionScope };
}

const credentialStore = createCredentialStore();
const rememberedSessions = require("./remembered-sessions").createRememberedSessions({
  filePath: path.join(process.env.DATA_DIR || path.dirname(credentialStore.filePath), "admin-sessions.json"),
  scope: () => credentialStore.sessionScope(),
});

function configured() {
  return Boolean(credentialStore.hasCredentials() && process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16);
}

function signature(sessionId) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "not-configured").update(sessionId).digest("base64url");
}

function parseCookies(header) {
  const result = {};
  for (const item of String(header || "").split(";")) {
    const pos = item.indexOf("=");
    if (pos < 1) continue;
    const key = item.slice(0, pos).trim();
    const value = item.slice(pos + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function cookieOptions(req, maxAgeSeconds) {
  return [
    `${COOKIE_NAME}=`, "Path=/api/admin", "HttpOnly", "SameSite=Strict",
    req.secure || process.env.COOKIE_SECURE === "true" ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean);
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const parts = cookieOptions(req, maxAgeSeconds);
  parts[0] = `${COOKIE_NAME}=${encodeURIComponent(value)}`;
  res.setHeader("Set-Cookie", parts.join("; "));
}

function createSession(req, res, { rememberMe = false } = {}) {
  const id = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const ttl = rememberMe === true ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
  const session = { id, createdAt: now, expiresAt: now + ttl, rememberMe: rememberMe === true };
  if (session.rememberMe) rememberedSessions.add(session);
  sessions.set(id, session);
  setSessionCookie(req, res, `${id}.${signature(id)}`, Math.floor(ttl / 1000));
  return session;
}

function getSession(req) {
  if (!configured()) return null;
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  if (!constantTimeEqual(raw.slice(dot + 1), signature(id))) return null;
  const session = sessions.get(id) || rememberedSessions.get(id);
  if (!session) return null;
  if (session.rememberMe && !rememberedSessions.get(id)) { sessions.delete(id); return null; }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    if (session.rememberMe) rememberedSessions.remove(id);
    return null;
  }
  sessions.set(id, session);
  return session;
}

function destroySession(req, res) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (raw) {
    const id = raw.split(".")[0];
    // A forged cookie must not revoke another device's stored session.
    if (getSession(req)) {
      rememberedSessions.remove(id);
      sessions.delete(id);
    }
  }
  setSessionCookie(req, res, "", 0);
}

function destroyAllSessions(req, res) {
  sessions.clear();
  rememberedSessions.clear();
  setSessionCookie(req, res, "", 0);
}

function verifyCredentials(username, password) {
  return configured() && credentialStore.verify(username, password);
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false, error: "Authentication required" });
  req.adminSession = session;
  next();
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
  try { rememberedSessions.cleanup(); } catch { console.error("[auth] remembered session cleanup failed"); }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, 10 * 60 * 1000);
cleanupTimer.unref?.();

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  configured,
  currentUsername: () => credentialStore.currentUsername(),
  verifyCredentials,
  updateCredentials: (changes) => credentialStore.update(changes),
  createSession,
  getSession,
  destroySession,
  destroyAllSessions,
  requireAdmin,
  _internals: {
    constantTimeEqual,
    parseCookies,
    sessions,
    hashPassword,
    validateUsername,
    validatePassword,
    createCredentialStore,
  },
};
