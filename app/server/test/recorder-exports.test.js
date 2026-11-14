"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shn48-exports-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.RECORDINGS_DIR = path.join(root, "recordings");
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const manager = require("../modules/recorder/manager");
const store = require("../lib/store");
const exportsModule = require("../modules/recorder/exports");

test.after(() => { exportsModule.stop(); fs.rmSync(root, { recursive: true, force: true }); });

function archivedWithBlocker() {
  const file = path.join(process.env.RECORDINGS_DIR, `e${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(file, "x");
  const done = manager.addRecording({ status: "done", filePath: file, mediaType: "video", source: "pocket48", liveId: "9001", duration: 600 });
  // pump() defers while any recording is active, so the queue stays parked and
  // no real ffmpeg ever runs in this test.
  manager.addRecording({ status: "recording", source: "pocket48", liveId: "9002", title: "blocker" });
  return done;
}

test("buildArgs: landscape fits with pad, portrait fills with crop, audio is -vn m4a", () => {
  const landscape = exportsModule._internals.buildArgs({ input: "in.mp4", output: "out.mp4", profile: { profile: "landscape", width: 1920, height: 1080, audioBitrate: "192k" }, burn: null });
  assert.ok(landscape.join(" ").includes("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"));
  assert.ok(landscape.includes("-map"), "video mapped");
  const portrait = exportsModule._internals.buildArgs({ input: "in.mp4", output: "out.mp4", profile: { profile: "portrait", width: 1080, height: 1920, audioBitrate: "192k" }, burn: null });
  assert.ok(portrait.join(" ").includes("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"));
  const audio = exportsModule._internals.buildArgs({ input: "in.mp4", output: "out.m4a", profile: { profile: "audio", audioBitrate: "192k" }, burn: null });
  assert.ok(audio.includes("-vn"));
  assert.ok(audio.includes("192k"), "audio bitrate applied");
});

test("burn-in composes the subtitles filter after geometry with escaped paths", () => {
  const chain = exportsModule._internals.videoFilterChain(
    { profile: "landscape" },
    { filter: `subtitles='${exportsModule._internals.filterEscape("C:\\tmp\\a b.srt")}'` },
  );
  assert.ok(chain.startsWith("scale=1920:1080"));
  assert.ok(chain.includes("subtitles="));
  assert.equal(exportsModule._internals.filterEscape("C:\\tmp\\a.srt"), "C\\:\\\\tmp\\\\a.srt");
  // Without burn-in the chain is geometry+format only.
  assert.ok(!exportsModule._internals.videoFilterChain({ profile: "portrait" }, null).includes("subtitles"));
});

test("enqueue validates recording state, profile/source compatibility and duplicates", () => {
  assert.throws(() => exportsModule.enqueue({ recordingId: "rec_missing", profile: "landscape" }), /归档不存在/);
  const rec = archivedWithBlocker();
  assert.throws(() => exportsModule.enqueue({ recordingId: rec.id, profile: "portrait", burnSubtitle: true }), /无法烧录字幕/, "burn-in without subtitles is refused before queueing");
  const plain = exportsModule.enqueue({ recordingId: rec.id, profile: "portrait" });
  assert.equal(plain.status, "queued");
  assert.ok(plain.fileName.endsWith(".portrait.mp4"));
  const duplicate = exportsModule.enqueue({ recordingId: rec.id, profile: "portrait" });
  assert.equal(duplicate.id, plain.id, "identical active jobs dedupe");
  const burned = exportsModule.enqueue({ recordingId: rec.id, profile: "landscape", burnSubtitle: false, language: "en" });
  assert.ok(burned.fileName.endsWith(".landscape.mp4"));
  // Audio sources only take the audio profile.
  const audioFile = path.join(process.env.RECORDINGS_DIR, "a1.m4a");
  fs.writeFileSync(audioFile, "x");
  const audioRec = manager.addRecording({ status: "done", filePath: audioFile, mediaType: "audio", source: "room_voice" });
  assert.throws(() => exportsModule.enqueue({ recordingId: audioRec.id, profile: "landscape" }), /仅音频档位/);
  assert.equal(exportsModule.enqueue({ recordingId: audioRec.id, profile: "audio" }).status, "queued");
  const listed = exportsModule.list();
  assert.ok(listed.length >= 3);
  assert.equal(listed[0].filePath, undefined, "dto hides internal paths in listings");
});
