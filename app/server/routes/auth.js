"use strict";

const express = require("express");
const auth = require("../lib/admin-auth");

const router = express.Router();
const LOGIN_WINDOW_MS = Math.max(60_000, Number(process.env.LOGIN_WINDOW_MS) || 15 * 60 * 1000);
const LOGIN_MAX_FAILURES = Math.max(3, Number(process.env.LOGIN_MAX_FAILURES) || 10);
const loginFailures = new Map();

function requestKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function failureState(req) {
  const key = requestKey(req);
  const now = Date.now();
  let state = loginFailures.get(key);
  if (!state || state.resetAt <= now) {
    if (loginFailures.size >= 10_000) loginFailures.delete(loginFailures.keys().next().value);
    state = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginFailures.set(key, state);
  }
  return { key, state };
}

const failureCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginFailures) if (state.resetAt <= now) loginFailures.delete(key);
}, LOGIN_WINDOW_MS);
failureCleanupTimer.unref?.();

router.post("/login", (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({
      success: false,
      error: "Administrator credentials are not configured",
    });
  }
  const { key, state } = failureState(req);
  if (state.count >= LOGIN_MAX_FAILURES) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000))));
    return res.status(429).json({ success: false, error: "Too many login attempts" });
  }
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    state.count += 1;
    return res.status(401).json({ success: false, error: "Invalid username or password" });
  }
  loginFailures.delete(key);
  const session = auth.createSession(req, res, { rememberMe: req.body?.rememberMe === true });
  res.json({
    success: true,
    data: { username: auth.currentUsername(), expiresAt: new Date(session.expiresAt).toISOString() },
  });
});

router.post("/logout", (req, res) => {
  auth.destroySession(req, res);
  res.json({ success: true });
});

router.put("/credentials", auth.requireAdmin, (req, res) => {
  const { key, state } = failureState(req);
  if (state.count >= LOGIN_MAX_FAILURES) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000))));
    return res.status(429).json({ success: false, error: "Too many authentication attempts" });
  }
  const { currentPassword, newUsername, newPassword } = req.body || {};
  let result;
  try {
    result = auth.updateCredentials({ currentPassword, newUsername, newPassword });
  } catch (error) {
    console.error("[auth] failed to persist administrator credentials:", error);
    return res.status(500).json({ success: false, error: "Could not save administrator credentials" });
  }
  if (!result.ok) {
    if (result.status === 401) state.count += 1;
    return res.status(result.status).json({ success: false, error: result.error });
  }

  // Credential changes invalidate every active administrator session.
  loginFailures.delete(key);
  auth.destroyAllSessions(req, res);
  return res.json({ success: true, authenticated: false });
});

router.get("/session", (req, res) => {
  const session = auth.getSession(req);
  if (!session) return res.status(401).json({ success: false, authenticated: false });
  res.json({
    success: true,
    authenticated: true,
    data: { username: auth.currentUsername(), expiresAt: new Date(session.expiresAt).toISOString() },
  });
});

module.exports = router;
module.exports._internals = { loginFailures, failureState };
