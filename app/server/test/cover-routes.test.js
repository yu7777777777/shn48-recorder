"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-routes-"));
process.env.DATA_DIR = root; process.env.COVERS_DIR = path.join(root, "covers");
process.env.ADMIN_USERNAME = "test"; process.env.ADMIN_PASSWORD = "test-password"; process.env.SESSION_SECRET = "test-secret-at-least-sixteen";
const { createApp } = require("../index");
const covers = require("../modules/recorder/covers");
const manager = require("../modules/recorder/manager");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test("cover settings and candidates require auth, candidates belong to one recording and upload locks hold", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/recordings`;
  try {
    for (const route of ["cover-settings", "cover-batch", "cover-members/123/photo"]) assert.equal((await fetch(`${base}/${route}`)).status, 401);
    const login = await fetch(`${base.replace('/recordings', '')}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test", password: "test-password" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const request = (url, method = "GET", body) => fetch(`${base}/${url}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await request("cover-settings")).status, 200);
    assert.equal((await request("cover-settings", "PUT", { theme: "invalid" })).status, 400);
    assert.equal((await request("cover-members/123", "PUT", { memberName: "成员" })).status, 200);
    const candidate = { file: "a".repeat(32) + ".jpg", source: "template", acceptable: true };
    fs.mkdirSync(process.env.COVERS_DIR, { recursive: true }); fs.writeFileSync(covers.file(candidate.file), "jpeg");
    const rec = manager.addRecording({ status: "done", coverCandidates: [candidate] });
    const other = manager.addRecording({ status: "done" });
    assert.equal((await request(`${rec.id}/cover-candidates/${candidate.file}`)).status, 200);
    assert.equal((await request(`${other.id}/cover-candidates/${candidate.file}`)).status, 404);
    manager.enqueueUpload({ recordingId: rec.id, status: "uploading" });
    assert.equal((await request(`${rec.id}/cover`, "POST", { candidateFile: candidate.file })).status, 409);
    assert.equal((await request(`${rec.id}/cover-candidates`, "POST", {})).status, 409);
    assert.equal((await request(`${other.id}/cover-sync`, "POST", {})).status, 502);
    assert.equal((await request("cover-batch", "POST", { ids: [] })).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
