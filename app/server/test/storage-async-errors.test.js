"use strict";

// storage.inventory async rewrite: classification semantics must stay identical
// to the old synchronous walk, the 3s TTL cache must only serve `{ cache: true }`
// callers, `GET /recordings` must report a filtered pre-limit total, and the
// global error handler must pass body-parser 4xx through instead of a blanket 500.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-storage-async-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
process.env.COVERS_DIR = path.join(root, "covers");
fs.mkdirSync(process.env.RECORDINGS_DIR);

const manager = require("../modules/recorder/manager");
const storage = require("../modules/recorder/storage");

const recordingsDir = process.env.RECORDINGS_DIR;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("async inventory keeps the old classification semantics", async () => {
  const mainFile = path.join(recordingsDir, "main.mp4");
  const fragment = path.join(recordingsDir, "frag.flv");
  const loose = path.join(recordingsDir, "loose.mp4");
  const leftover = path.join(recordingsDir, "leftover.mp4");
  fs.writeFileSync(mainFile, Buffer.alloc(100));
  fs.writeFileSync(fragment, Buffer.alloc(40));
  fs.writeFileSync(loose, Buffer.alloc(10));
  fs.writeFileSync(leftover, Buffer.alloc(5));
  const doneRec = manager.addRecording({ title: "主文件", status: "done", filePath: mainFile, sourceFiles: [fragment] });
  manager.addRecording({ status: "deleted", filePath: leftover });

  let data = await storage.inventory(recordingsDir);
  const byName = Object.fromEntries(data.files.map(f => [f.name, f]));
  assert.equal(byName["main.mp4"].kind, "main");
  assert.equal(byName["frag.flv"].kind, "source");
  assert.equal(byName["loose.mp4"].kind, "untracked");
  assert.equal(byName["leftover.mp4"].kind, "residual");
  assert.equal(data.fileCount, 4);
  assert.equal(data.totalBytes, 155);
  assert.equal(data.extraBytes, 55);
  assert.equal(byName["main.mp4"].recordingTitle, doneRec.title);
  assert.equal(byName["main.mp4"].id, crypto.createHash("sha256").update("main.mp4").digest("hex"));
  for (const file of data.files) assert.equal(file.locked, false, "nothing is locked without leases or active recordings");

  // Official replay cache: transient assets are skipped, the verified main file
  // of an official_replay archive is classified as "main".
  const liveId = "1320546015452663800";
  const replayDir = path.join(recordingsDir, ".official-replays", liveId);
  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(path.join(replayDir, "asset-00001.ts"), Buffer.alloc(7));
  fs.writeFileSync(path.join(replayDir, "verified.mp4"), Buffer.alloc(30));
  manager.addRecording({ source: "pocket48", liveId, status: "done", filePath: path.join(replayDir, "verified.mp4"), archiveOrigin: "official_replay" });
  data = await storage.inventory(recordingsDir);
  assert.equal(data.files.some(f => f.name.endsWith("asset-00001.ts")), false, "transient replay cache is skipped");
  const verified = data.files.find(f => f.name.endsWith("verified.mp4"));
  assert.equal(verified.kind, "main");
  assert.equal(data.fileCount, 5);
  assert.equal(data.totalBytes, 185);
  assert.equal(data.extraBytes, 55, "verified.mp4 is a main file, so extra stays frag+loose+leftover");

  // An active recording locks untracked files but not owned main files.
  const active = manager.addRecording({ status: "recording" });
  data = await storage.inventory(recordingsDir);
  const names = Object.fromEntries(data.files.map(f => [f.name, f]));
  assert.equal(names["loose.mp4"].locked, true);
  assert.equal(names["main.mp4"].locked, false);
  assert.equal(verified.kind, "main");
  manager.updateRecording(active.id, { status: "done" });
});

test("inventory TTL cache reuses results within 3s and the default path always rescans", { timeout: 20000 }, async () => {
  const base = await storage.inventory(recordingsDir, { cache: true });
  const added = path.join(recordingsDir, "cache-probe.mp4");
  fs.writeFileSync(added, Buffer.alloc(1));

  const cached = await storage.inventory(recordingsDir, { cache: true });
  assert.equal(cached, base, "a cache:true call within the TTL returns the same result object");
  assert.equal(cached.fileCount, base.fileCount, "cache:true within the TTL does not rescan");

  const fresh = await storage.inventory(recordingsDir);
  assert.notEqual(fresh, base);
  assert.equal(fresh.fileCount, base.fileCount + 1, "the default path scans fresh");

  const stillStale = await storage.inventory(recordingsDir, { cache: true });
  assert.equal(stillStale, base, "the default path never refreshes the cache");

  await new Promise(r => setTimeout(r, 3100));
  const expired = await storage.inventory(recordingsDir, { cache: true });
  assert.notEqual(expired, base);
  assert.equal(expired.fileCount, base.fileCount + 1, "after the TTL the cache:true path rescans");

  fs.unlinkSync(added);
  const afterRemove = await storage.inventory(recordingsDir);
  assert.equal(afterRemove.fileCount, base.fileCount, "the default path reflects deletions immediately");
});

test("GET /recordings reports meta.total after filters but before the limit", async () => {
  for (let i = 0; i < 3; i += 1) manager.addRecording({ status: "done", filePath: path.join(recordingsDir, `done-${i}.mp4`) });
  for (let i = 0; i < 2; i += 1) manager.addRecording({ status: "recording" });
  // Records from the classification test remain: 3 done + 1 deleted (excluded).
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/recordings", require("../routes/recordings"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/recordings`;
    const done = await (await fetch(`${base}?status=done&limit=1`)).json();
    assert.equal(done.success, true);
    assert.equal(done.data.length, 1);
    assert.ok(done.data.every(r => r.status === "done"));
    assert.equal(done.meta.total, 6, "3 new + 3 earlier done records, before the limit");

    const recording = await (await fetch(`${base}?status=recording`)).json();
    assert.equal(recording.meta.total, 2);

    const all = await (await fetch(`${base}?limit=2`)).json();
    assert.equal(all.data.length, 2);
    assert.equal(all.meta.total, 8, "6 done + 2 recording, deleted excluded");
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

test("fallback error handler passes body-parser 4xx through instead of 500", async () => {
  const { createApp } = require("../index");
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const malformed = await fetch(`${base}/api/admin/recordings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"broken' });
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.success, false);
    assert.ok(malformedBody.error);

    const oversized = await fetch(`${base}/api/admin/recordings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(3 * 1024 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).success, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

test("process handlers: unhandledRejection keeps the process alive, uncaughtException saves state and exits 1", { timeout: 30000 }, async () => {
  // Runs in a child because these handlers are registered by startServer() and
  // the uncaughtException path must be allowed to end that process.
  const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-storage-async-child-"));
  const script = [
    "const index = require('./index');",
    "index.startServer();",
    "setTimeout(() => { Promise.reject(new Error('boom-rejection')); }, 150);",
    "setTimeout(() => { console.log('REJECTION_SURVIVED'); }, 400);",
    "setTimeout(() => { throw new Error('boom-uncaught'); }, 600);",
  ].join("\n");
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      DATA_DIR: path.join(childRoot, "data"),
      RECORDINGS_DIR: path.join(childRoot, "recordings"),
      COVERS_DIR: path.join(childRoot, "covers"),
      PORT: String(30000 + Math.floor(Math.random() * 20000)),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve) => {
    const watchdog = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 20000);
    child.on("close", (exitCode) => { clearTimeout(watchdog); resolve(exitCode); });
  });
  const elapsed = Date.now() - started;
  try { fs.rmSync(childRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  assert.equal(code, 1, `child should exit 1 after the uncaught exception; output:\n${output}`);
  assert.ok(output.includes("REJECTION_SURVIVED"), `the process must survive the unhandled rejection; output:\n${output}`);
  assert.match(output, /unhandled promise rejection[\s\S]*boom-rejection/);
  assert.match(output, /uncaught exception[\s\S]*boom-uncaught/);
  assert.ok(elapsed >= 3000, `the exit must be delayed by the 3s save window (took ${elapsed}ms)`);
});
