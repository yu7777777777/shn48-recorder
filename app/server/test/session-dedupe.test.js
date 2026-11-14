"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-session-dedupe-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
process.env.COVERS_DIR = path.join(root, "covers");
process.env.COOKIES_PATH = path.join(root, "cookies.json");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
const manager = require("../modules/recorder/manager");
const archive = require("../modules/recorder/archive-processor");
test.after(() => { archive.stop(); fs.rmSync(root, { recursive: true, force: true }); });

function touch(name) {
  const file = path.join(process.env.RECORDINGS_DIR, name);
  fs.writeFileSync(file, "x");
  return file;
}
function live(extra = {}) {
  return manager.addRecording({
    source: "pocket48", liveId: "123456", memberId: "m1", memberName: "测试成员",
    title: "同一场直播", liveTitle: "同一场直播", status: "recording",
    startedAt: "2026-05-01T10:00:00Z",
    filePath: touch(`seg-${Math.random().toString(36).slice(2)}.flv`), ...extra,
  });
}

test("a second start for the same live attaches as a segment instead of a new archive", () => {
  const first = live();
  assert.equal(first.segment, undefined);
  assert.equal(first.sessionId, undefined);

  const second = live({ reconnectOf: first.id });
  assert.notEqual(second.id, first.id);
  assert.equal(second.segment, true);
  assert.equal(second.sessionId, first.id);
  assert.equal(second.liveId, "123456");

  const owners = manager.getRecordings().filter(r => r.liveId === "123456" && !r.segment);
  assert.equal(owners.length, 1, "only one session owner may exist for a liveId");
});

test("segments inherit the owner session across a restart-shaped state", () => {
  const owner = live({ liveId: "555001" });
  // A restart finalizes the old entry and the next start has no reconnectOf.
  manager.updateRecording(owner.id, { status: "waiting_merge", endedAt: "2026-05-01T10:00:05Z" });
  const segment = live({ liveId: "555001", status: "recording", startedAt: "2026-05-01T10:30:00Z" });
  assert.equal(segment.segment, true);
  assert.equal(segment.sessionId, owner.id);
  const sessions = archive._internals.splitSessions(
    manager.getRecordings().filter(r => r.liveId === "555001" && r.status !== "merged")
  );
  assert.equal(sessions.length, 1, "segments of one live must form a single archive session");
});

test("a deleted owner does not block a fresh archive", () => {
  const owner = live({ liveId: "777001" });
  manager.updateRecording(owner.id, { status: "deleted" });
  const fresh = live({ liveId: "777001" });
  assert.equal(fresh.segment, undefined);
  assert.equal(fresh.sessionId, undefined);
});

test("explicit segments are recognised as an auto-reconnect pair", () => {
  const owner = live({ liveId: "888002", autoMonitorId: "m1", endedAt: "2026-05-01T10:00:05Z" });
  const segment = live({ liveId: "888002", autoMonitorId: "m1", startedAt: "2026-05-01T11:30:00Z" });
  assert.equal(segment.sessionId, owner.id);
  assert.equal(archive._internals.compatible(owner, segment), true);
  assert.equal(archive._internals.isAutoReconnectPair(owner, segment), true);
  const pair = archive._internals.splitSessions([owner, segment], 1);
  assert.equal(pair.length, 1, "a linked segment must merge even beyond the default window");
});

test("different lives are never merged", () => {
  const a = live({ liveId: "900001" });
  const b = live({ liveId: "900002" });
  assert.equal(b.segment, undefined);
  assert.equal(archive._internals.compatible(a, b), false);
});

test("clips sharing a liveId are not treated as session owners", () => {
  const parent = live({ liveId: "910001" });
  const derived = manager.addRecording({
    source: "clip", parentRecordingId: parent.id, liveId: "910001",
    memberId: "m1", memberName: "测试成员", status: "done", filePath: touch("clip.mp4"),
  });
  assert.equal(derived.segment, undefined, "a clip must not be rewritten as a segment");
  const next = live({ liveId: "910001" });
  assert.equal(next.sessionId, parent.id);
});
