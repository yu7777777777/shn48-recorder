"use strict";
// Deleting one of two archives that share a live must succeed. Only the archive's
// own main file is exclusive; a shared replay cache or shared original segment is
// detached from the record being deleted and left on disk for the other archive.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-shared-delete-"));
process.env.DATA_DIR = root;
process.env.COVERS_DIR = path.join(root, "covers");
process.env.COOKIES_PATH = path.join(root, "cookies.json");
process.env.ADMIN_USERNAME = "test";
process.env.ADMIN_PASSWORD = "test-password";
process.env.SESSION_SECRET = "test-secret-at-least-sixteen";
const manager = require("../modules/recorder/manager");
const storage = require("../modules/recorder/storage");
const { createApp } = require("../index");

const recordingsDir = path.join(root, "recordings", "pocket48");
fs.mkdirSync(recordingsDir, { recursive: true });
process.env.RECORDINGS_DIR = recordingsDir;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name) {
  const file = path.join(recordingsDir, name);
  fs.writeFileSync(file, `content-${name}`);
  return file;
}

test("a shared replay file does not block deleting a duplicate archive", async () => {
  const sharedReplay = write("official-replay.mp4");
  const ownMain = write("owner-main.mp4");
  const otherMain = write("other-main.mp4");

  const target = manager.addRecording({
    id: "dup-a", source: "pocket48", liveId: "99001", title: "杨晔-快乐", status: "done",
    filePath: ownMain, sourceFiles: [sharedReplay],
    replayRecovery: { status: "replaced", replayFilePath: sharedReplay },
  });
  const keeper = manager.addRecording({
    id: "dup-b", source: "pocket48", liveId: "99001", title: "杨晔-快乐", status: "done",
    filePath: otherMain, sourceFiles: [sharedReplay],
    replayRecovery: { status: "replaced", replayFilePath: sharedReplay },
  });
  assert.ok(storage.paths(target).includes(sharedReplay));

  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test", password: "test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${base}/recordings/dup-a`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.success, true);

    // The duplicate is gone from the list and its own main file is unlinked.
    assert.equal(manager.getRecording("dup-a").status, "deleted");
    assert.equal(fs.existsSync(ownMain), false, "the deleted archive's main file is removed");
    // The shared replay survives for the archive that still references it.
    assert.equal(fs.existsSync(sharedReplay), true, "a shared replay file must survive");
    assert.ok(storage.paths(keeper).includes(sharedReplay), "the surviving archive keeps its replay reference");
    assert.equal(fs.existsSync(otherMain), true, "the surviving archive's main file is untouched");
    assert.ok(manager.getRecordings().every(r => r.id !== "dup-a"), "the deleted duplicate leaves the list");
    assert.ok(manager.getRecordings().some(r => r.id === "dup-b"), "the other archive remains listed");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("two archives sharing one main file can be deleted one at a time", async () => {
  const sharedMain = write("shared-main.mp4");
  manager.addRecording({
    id: "lock-a", source: "pocket48", liveId: "99002", title: "共享主文件", status: "done", filePath: sharedMain,
  });
  manager.addRecording({
    id: "lock-b", source: "pocket48", liveId: "99002", title: "共享主文件", status: "done", filePath: sharedMain,
  });

  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test", password: "test-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const del = id => fetch(`${base}/recordings/${id}`, { method: "DELETE", headers: { Cookie: cookie } });

    // The duplicate leaves the list; the physical file survives for the survivor.
    const first = await del("lock-a");
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(manager.getRecording("lock-a").status, "deleted");
    assert.equal(fs.existsSync(sharedMain), true, "a file still referenced elsewhere is kept");
    assert.equal(manager.getRecording("lock-b").status, "done");

    // Deleting the last holder reclaims the file.
    const second = await del("lock-b");
    assert.equal(second.status, 200);
    assert.equal(fs.existsSync(sharedMain), false, "the last holder unlinks the file");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a segment shared with another archive is detached, not unlinked", async () => {
  const mainFile = write("keeper-main.mp4");
  const sharedSegment = write("shared-segment.flv");

  // The target owns mainFile and lists sharedSegment; another archive owns that
  // same segment file as its own archive main file.
  manager.addRecording({
    id: "seg-a", source: "pocket48", liveId: "99003", title: "片段归属", status: "done",
    filePath: mainFile, sourceFiles: [sharedSegment],
  });
  manager.addRecording({
    id: "seg-b", source: "pocket48", liveId: "99003", title: "片段归属", status: "done",
    filePath: sharedSegment,
  });

  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test", password: "test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${base}/recordings/seg-a`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.success, true);

    // The target's own main file is reclaimed, the shared segment is not.
    assert.equal(fs.existsSync(mainFile), false, "the deleted archive's own main file is removed");
    assert.equal(fs.existsSync(sharedSegment), true, "the segment another archive owns survives");
    assert.ok(body.data.sharedFilesKept.some(p => p.endsWith("shared-segment.flv")));
    assert.equal(manager.getRecording("seg-a").status, "deleted");
    assert.equal(manager.getRecording("seg-b").status, "done", "the other archive is untouched");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
