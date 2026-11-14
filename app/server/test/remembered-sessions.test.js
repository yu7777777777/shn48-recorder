"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { fork } = require("child_process");
const { createRememberedSessions } = require("../lib/remembered-sessions");

if (process.env.REMEMBER_AUTH_TEST_CHILD === "1") {
  const express = require("express"), auth = require("../lib/admin-auth");
  const app = express(); app.use(express.json()); app.use("/api/admin/auth", require("../routes/auth"));
  app.get("/private", auth.requireAdmin, (_, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  process.on("message", msg => { if (msg === "stop") server.close(() => process.exit(0)); });
} else {
  async function harness(t) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "remember-auth-")); let child, base;
    const environment = { ...process.env, DATA_DIR: data, ADMIN_CREDENTIALS_PATH: path.join(data, "admin-credentials.json"),
      ADMIN_USERNAME: "remember-test", ADMIN_PASSWORD: "Remember-test-123", SESSION_SECRET: "remember-isolated-test-secret", COOKIE_SECURE: "false", REMEMBER_AUTH_TEST_CHILD: "1" };
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const current = child; await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { current.kill("SIGKILL"); reject(new Error("Auth child did not stop")); }, 5000);
        current.once("exit", () => { clearTimeout(timeout); resolve(); }); current.send("stop");
      }); child = null;
    }
    async function start(extra = {}) {
      await stop();
      child = fork(__filename, [], { env: { ...environment, ...extra }, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Auth child did not start")), 8000);
        child.once("message", msg => { clearTimeout(timeout); resolve(msg.port); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
      }); base = `http://127.0.0.1:${port}`;
    }
    t.after(async () => { await stop(); fs.rmSync(data, { recursive: true, force: true }); });
    async function request(route, cookie, body, method = body ? "POST" : "GET") {
      return fetch(base + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    }
    async function login(rememberMe, password = environment.ADMIN_PASSWORD) {
      const response = await request("/api/admin/auth/login", null, { username: environment.ADMIN_USERNAME, password, rememberMe });
      assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0];
    }
    await start(); return { data, start, login, request };
  }

  test("remembered login survives process replacement; ordinary login and forged cookies do not", async t => {
    const h = await harness(t), remembered = await h.login(true), ordinary = await h.login(false);
    const serialized = fs.readFileSync(path.join(h.data, "admin-sessions.json"), "utf8");
    const id = decodeURIComponent(remembered.split("=")[1]).split(".")[0];
    assert.equal(serialized.includes(id), false); assert.equal(serialized.includes("Remember-test-123"), false);
    assert.equal(serialized.includes("remember-isolated-test-secret"), false);
    // Windows reports synthetic 0666 for every file and ignores chmod(), so the
    // POSIX mode assertion is only meaningful there; the file still sits in the
    // private data directory.
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(h.data, "admin-sessions.json")).mode & 0o777, 0o600);
    await h.start(); assert.equal((await h.request("/private", remembered)).status, 200);
    assert.equal((await h.request("/private", ordinary)).status, 401);
    const forged = remembered.slice(0, -1) + (remembered.endsWith("x") ? "y" : "x");
    assert.equal((await h.request("/private", forged)).status, 401);
    await h.request("/api/admin/auth/logout", forged, {}, "POST");
    assert.equal((await h.request("/private", remembered)).status, 200);
    await h.start({ SESSION_SECRET: "a-different-session-secret-long" });
    assert.equal((await h.request("/private", remembered)).status, 401);
  });

  test("logout persists per-device revocation; credential changes revoke all remembered devices after restart", async t => {
    const h = await harness(t), first = await h.login(true), second = await h.login(true);
    await h.request("/api/admin/auth/logout", first, {}, "POST"); await h.start();
    assert.equal((await h.request("/private", first)).status, 401); assert.equal((await h.request("/private", second)).status, 200);
    const response = await h.request("/api/admin/auth/credentials", second, { currentPassword: "Remember-test-123", newPassword: "Changed-test-456" }, "PUT");
    assert.equal(response.status, 200); await h.start(); assert.equal((await h.request("/private", second)).status, 401);
    const fresh = await h.login(true, "Changed-test-456"); await h.start(); assert.equal((await h.request("/private", fresh)).status, 200);
    const store = path.join(h.data, "admin-sessions.json"), saved = JSON.parse(fs.readFileSync(store, "utf8"));
    for (const entry of saved.sessions) { entry.createdAt = Date.now() - 31 * 86400000; entry.expiresAt = Date.now() - 86400000; }
    fs.writeFileSync(store, JSON.stringify(saved)); await h.start(); assert.equal((await h.request("/private", fresh)).status, 401);
  });

  test("saved-session corruption fails closed and failed writes never grant a remembered session", t => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "remember-store-")); t.after(() => fs.rmSync(data, { recursive: true, force: true }));
    const filePath = path.join(data, "sessions.json"), scope = () => "test-scope", id = "a-secret-login-token";
    fs.writeFileSync(filePath, "broken json"); const store = createRememberedSessions({ filePath, scope }); assert.equal(store.get(id), null);
    const session = { id, createdAt: Date.now(), expiresAt: Date.now() + 1000 }; store.add(session);
    assert.ok(createRememberedSessions({ filePath, scope }).get(id));
    assert.equal(createRememberedSessions({ filePath, scope: () => "changed-credential-scope" }).get(id), null);
    const blocked = path.join(data, "blocked"); fs.mkdirSync(blocked);
    const failed = createRememberedSessions({ filePath: blocked, scope }); assert.throws(() => failed.add(session)); assert.equal(failed.get(id), null);
  });
}
