"use strict";
// Isolated audit regressions. Application modules execute in VM contexts with
// explicit dependencies: no application store, upstream request or real ffmpeg.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
function load(name, deps, extra = {}) {
  const module = { exports: {} };
  const filename = path.join(__dirname, "../modules/recorder", name);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, require(key) {
      if (!(key in deps)) throw Error(`Unmocked dependency: ${key}`);
      return deps[key];
    }, console, Buffer, URL, process: { env: {} },
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    setInterval: () => ({ unref() {} }), clearInterval() {}, ...extra,
  }, { filename });
  return module.exports;
}
function restartFixture(options = {}) {
  const root = path.resolve("audit-memory-recordings");
  const old = path.join(root, "before.partial.flv"), fresh = path.join(root, "after.flv");
  const persisted = [{ id: "owner", source: "pocket48", liveId: "123", memberId: "1", memberName: "member", liveTitle: "test", title: "test", status: "recording", filePath: old, startedAt: "2026-10-23T09:00:00Z", ...options.owner }];
  const store = { load: (key, fallback) => key === "recordings" ? JSON.parse(JSON.stringify(persisted)) : fallback, save() {}, atomicWrite() {}, filePath: key => key };
  const manager = load("manager.js", { "../../lib/store": store, "../../lib/sse": { broadcast() {} }, "../notify": { event() {} } });
  const segment = manager.addRecording({ source: "pocket48", liveId: "123", memberId: "1", memberName: "member", title: "test", liveTitle: "test", status: "waiting_merge", filePath: fresh, startedAt: "2026-10-23T09:05:00Z", endedAt: "2026-10-23T09:10:00Z" });
  const alias = options.activeAlias ? manager.addRecording({ source: "writer", status: "recording", filePath: old }) : null;
  let probedOld = false;
  const known = new Set([old, fresh]);
  const fakeFs = {
    existsSync: file => known.has(file), realpathSync: file => file === old && options.replaced && probedOld ? path.resolve("outside-root.flv") : file,
    lstatSync: file => ({ isFile: () => !(file === old && options.symlink) }),
    statSync: file => ({ size: file === old && options.empty ? 0 : 100, mtimeMs: file === old && options.changed && probedOld ? 2 : 1 }),
    writeFileSync() {}, unlinkSync() {}, renameSync: (from, to) => known.add(to),
  };
  const calls = []; let merged = false;
  function spawn(bin, args) {
    calls.push({ bin, args });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    setImmediate(() => {
      if (bin === "ffprobe") {
        const file = args.at(-1);
        if (file === old && options.invalid) { child.emit("close", 1); return; }
        if (file === old) probedOld = true;
        if (file === old && options.onProbe) options.onProbe(manager);
        child.stdout.emit("data", JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16 }], format: { duration: file.endsWith(".processing.mp4") && merged ? "2" : "1" } }));
      } else if (args.includes("concat")) merged = true;
      child.emit("close", 0);
    });
    return child;
  }
  const recorder = { listActive: () => options.active ? [{ recordingId: "owner" }] : alias ? [{ recordingId: alias.id }] : [], onFinalized: () => () => {}, _internals: { recordingsDir: () => root, safeName: value => value } };
  const scheduled = [];
  const archive = load("archive-processor.js", {
    fs: fakeFs, path, child_process: { spawn }, "./manager": manager, "../pocket48/recorder": recorder,
    "../bilibili/queue": {}, "../backup115/leases": { lockedPath: () => false },
    "./replay-recovery": { _internals: { needsQualityGate: () => false } }, "./covers": { generate: async () => {} },
  }, { setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return { unref() {} }; } });
  return { manager, archive, segment, old, fresh, calls, scheduled };
}
test("F02 actual loadState -> reconnect -> archive preserves both usable segments", async () => {
  const f = restartFixture();
  assert.equal(f.manager.getRecording("owner").status, "failed");
  assert.equal(f.manager.getRecording("owner").interruptedByRestart, true);
  assert.equal(f.segment.sessionId, "owner");
  const archive = await f.archive.processRecording(f.segment.id, { immediate: true, autoEnqueue: false });
  assert.equal(archive.id, "owner");
  assert.equal(archive.segmentCount, 2);
  assert.deepEqual(Array.from(archive.sourceFiles), [f.old, f.fresh]);
  assert.equal(f.segment.status, "merged");
});
test("F02 start schedules only restart-specific failed records and supports legacy marker", () => {
  const f = restartFixture({ owner: { status: "failed", error: "Server restarted before recording completed" } });
  f.archive.start();
  assert.equal(f.scheduled.length, 2);
  f.archive.stop();
});
for (const [name, options] of [
  ["arbitrary failure", { owner: { status: "failed", error: "unrelated media failure" } }],
  ["zero-length file", { empty: true }],
  ["invalid media", { invalid: true }],
  ["active writer", { active: true }],
  ["different-ID writer on the same path", { activeAlias: true }],
  ["symlink", { symlink: true }],
  ["changed media during probe", { changed: true }],
  ["replaced realpath during probe", { replaced: true }],
  ["state changed during probe", { onProbe: manager => manager.updateRecording("owner", { status: "deleted" }) }],
]) {
  test(`F02 does not revive ${name}`, async () => {
    const f = restartFixture(options);
    try { await f.archive.processRecording(f.segment.id, { immediate: true, autoEnqueue: false }); } catch (error) {
      assert.match(error.message, /仍在录制/);
    }
    assert.notEqual(f.manager.getRecording("owner").status, "done");
    assert.equal(f.manager.getRecording("owner").filePath, f.old);
    assert.ok(!f.segment.sourceFiles?.includes(f.old));
  });
}
function retentionFixture(verifiedAt) {
  const root = path.resolve("audit-retention-memory"), main = path.join(root, "archive.mp4"), raw = path.join(root, "original.flv");
  const files = new Map([[main, { size: 1000, mtimeMs: 100 }], [raw, { size: 400, mtimeMs: 100 }]]);
  const records = [{ id: "r", status: "done", filePath: main, sourceFiles: [raw], retentionVerifiedAt: verifiedAt }];
  const manager = { getRecordings: () => records, getQueue: () => [], updateRecording: (id, updates) => Object.assign(records.find(r => r.id === id), updates) };
  const stat = file => { const value = files.get(path.resolve(file)); if (!value) throw Error("missing"); return { ...value, isFile: () => true }; };
  const fakeFs = {
    realpathSync: file => path.resolve(file), statSync: stat, lstatSync: stat,
    existsSync: file => path.resolve(file) === root || files.has(path.resolve(file)),
    statfsSync: () => ({ bavail: 0n, bsize: 4096n }), unlinkSync: file => files.delete(path.resolve(file)),
    readdirSync: () => [...files.keys()].map(file => ({ name: path.basename(file), isFile: () => true, isDirectory: () => false })),
  };
  // storage.js walks the tree asynchronously; mirror the sync stubs so the
  // in-memory fixture keeps exercising the same classification rules.
  fakeFs.promises = {
    readdir: async () => fakeFs.readdirSync(undefined, { withFileTypes: true }),
    stat: async file => stat(file),
  };
  const leases = { lockedPath: () => false, lockedRecording: () => false }, noBusy = { busy: () => false };
  const storage = load("storage.js", { fs: fakeFs, path, crypto, "./manager": manager, "../backup115/leases": leases, "./replay-recovery": noBusy, "../analysis/service": noBusy, "./clips": noBusy });
  const retention = load("retention.js", { fs: fakeFs, path, "./manager": manager, "./storage": storage, "./replay-download": { verifyFull: async () => {} }, "../backup115/leases": leases, "./replay-audit": noBusy, "../pocket48/recorder": { _internals: { recordingsDir: () => root } } });
  return { retention, root, files, raw, main };
}
test("F08 sweep followed immediately by pressured purge preserves original", async () => {
  const f = retentionFixture();
  await f.retention.sweep();
  const result = await f.retention.purge(f.root);
  assert.equal(result.files, 0);
  assert.equal(f.files.has(f.raw), true);
});
for (const [name, age] of [["recent", new Date(Date.now() - 3600000).toISOString()], ["invalid", "not-a-date"], ["future", new Date(Date.now() + 86400000).toISOString()]]) {
  test(`F08 purge protects ${name} verification timestamp`, async () => {
    const f = retentionFixture(age); await f.retention.purge(f.root); assert.ok(f.files.has(f.raw));
  });
}
test("F08 expired window permits reclaiming original but never main", async () => {
  const f = retentionFixture(new Date(Date.now() - 86400001).toISOString());
  await f.retention.purge(f.root);
  assert.equal(f.files.has(f.raw), false); assert.equal(f.files.has(f.main), true);
});
function replayFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-replay-regression-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const plan = { liveId: "123", resources: [{ name: "asset-00000.ts", url: "https://cdn.example/a.ts?old=1" }, { name: "asset-00001.ts", url: "https://cdn.example/b.ts?expired=1" }], completed: { "asset-00000.ts": { bytes: 5, sha256: hash("OLD_A") } }, scope: { origin: "https://cdn.example", hostname: "cdn.example", pathPrefix: "/", resourcePathPrefixes: ["/"] }, local: "#EXTM3U", seconds: 10 };
  fs.writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan));
  fs.writeFileSync(path.join(directory, "asset-00000.ts"), "OLD_A");
  const requests = [], validated = []; let lookups = 0, scopes = 0, observed;
  const manifest = "#EXTM3U\n#EXTINF:5,\na.ts?fresh=1\n#EXTINF:5,\nb.ts?fresh=1\n#EXT-X-ENDLIST\n";
  const proxy = {
    MANIFEST_MAX_BYTES: 10000, decodeManifest: bytes => bytes.toString(), authorizeManifestResources() {},
    validateSourceUrl(value) { const url = new URL(value); validated.push(url.href); if (url.hostname !== "cdn.example") throw Error("unsafe host"); return url; },
    scopeFor: () => { scopes++; return { origin: "https://cdn.example", hostname: "cdn.example", pathPrefix: "/", resourcePathPrefixes: new Set(["/"]) }; },
  };
  function spawn(bin, args) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    child.kill = () => {};
    setImmediate(() => {
      if (bin === "ffprobe") child.stdout.emit("data", JSON.stringify({ streams: [{ codec_type: "video", width: 16, height: 16 }], format: { duration: "10" } }));
      else fs.writeFileSync(args.at(-1), "MOCK_MUXED_VIDEO");
      child.emit("close", 0);
    });
    return child;
  }
  const media = load("replay-download.js", {
    fs: { ...fs, statfsSync: () => ({ bavail: 1000000n, bsize: 4096n }) }, path, crypto,
    "stream/promises": require("stream/promises"), stream: require("stream"), child_process: { spawn },
    "../../lib/store": { atomicWrite: (file, value) => fs.writeFileSync(file, JSON.stringify(value)) },
    "../pocket48/replay-proxy": { _internals: proxy }, "../pocket48/replay": {}, "../backup115/leases": { lockedPath: () => false },
  });
  const input = {
    liveId: "123", directory, verify: false,
    getReplay: async () => { lookups++; return { replay: { liveId: options.wrongLive ? "456" : "123" }, streamUrl: options.unsafe ? "https://evil.example/replay.m3u8" : "https://cdn.example/replay.m3u8" }; },
    request: async url => {
      requests.push(url);
      const isManifest = url.endsWith(".m3u8");
      const expired = !isManifest && (url.includes("expired=1") || options.alwaysExpired);
      const response = Readable.from([Buffer.from(isManifest ? manifest : url.includes("a.ts") ? "NEW_A" : "NEW_B")]);
      response.statusCode = expired ? (options.status || 403) : 200; response.headers = {}; response.complete = true;
      return { response, finalUrl: new URL(url) };
    },
    onProgress(progress) {
      if (progress.verifying) observed = fs.readFileSync(path.join(directory, "asset-00000.ts"), "utf8");
    },
  };
  return { media, input, requests, validated, lookupCount: () => lookups, scopeCount: () => scopes, observed: () => observed };
}
test("F09 expired cached plan refreshes same live/scope and redownloads changed same-name resources", async t => {
  const f = replayFixture(t); const result = await f.media.download(f.input);
  assert.equal(result.liveId, "123"); assert.equal(f.lookupCount(), 1); assert.equal(f.scopeCount(), 1);
  assert.ok(f.validated.includes("https://cdn.example/a.ts?fresh=1"));
  assert.ok(f.requests.includes("https://cdn.example/a.ts?fresh=1"));
  assert.equal(f.observed(), "NEW_A", "old completed hash must not authorize new generation bytes");
});
test("F09 repeated expiry refreshes at most once per download", async t => {
  const f = replayFixture(t, { alwaysExpired: true });
  await assert.rejects(f.media.download(f.input), { code: "REPLAY_RESOURCE_EXPIRED" });
  assert.equal(f.lookupCount(), 1); assert.equal(f.scopeCount(), 1);
  assert.equal(f.requests.filter(url => url.endsWith(".m3u8")).length, 1);
  assert.ok(f.requests.length <= 10);
});
test("F09 refreshed metadata cannot substitute a different live", async t => {
  const f = replayFixture(t, { wrongLive: true });
  await assert.rejects(f.media.download(f.input), /同场官方回放暂不可用/);
  assert.equal(f.scopeCount(), 0);
});
test("F09 refreshed metadata is checked by URL authorization", async t => {
  const f = replayFixture(t, { unsafe: true });
  await assert.rejects(f.media.download(f.input), /unsafe host/);
  assert.equal(f.requests.some(url => url.includes("evil.example")), false);
});
test("F09 server errors do not discard resumable plan or refresh metadata", async t => {
  const f = replayFixture(t, { status: 500 });
  await assert.rejects(f.media.download(f.input), /分片失效或下载失败/);
  assert.equal(f.lookupCount(), 0);
  assert.equal(f.requests.length, 3);
});
