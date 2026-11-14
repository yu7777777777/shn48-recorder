"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-media-"));
process.env.DATA_DIR = root;
process.env.COVERS_DIR = path.join(root, "covers");
const covers = require("../modules/recorder/covers");
const manager = require("../modules/recorder/manager");
const { run } = require("../lib/cli");
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
const python = process.env.COVER_PYTHON_BIN || (process.platform === "win32" ? "python" : "/opt/asr-venv/bin/python");
const available = spawnSync(ffmpeg, ["-version"]).status === 0 && spawnSync(python, ["-c", "import cv2; from PIL import Image"]).status === 0;
const photo = process.env.COVER_FACE_FIXTURE;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("real blank video uses a 960x540 Chinese template and invalid uploads preserve its cover", { skip: !available }, async () => {
  const video = path.join(root, "blank.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x288:d=1", "-y", video]);
  const r = manager.addRecording({ status: "done", source: "pocket48", memberId: "123", memberName: "SNH48-测试成员", liveTitle: "你好，直播回放", filePath: video });
  await covers.generate(r);
  assert.equal(r.coverSource, "template");
  assert.ok(r.coverCandidates.filter(c => c.source === "smart").every(c => !c.acceptable));
  const dimensions = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", covers.file(r.coverFile)]);
  assert.deepEqual(JSON.parse(dimensions.stdout).streams.map(s => [s.width, s.height]), [[960, 540]]);
  const saved = r.coverFile;
  await assert.rejects(covers.generate(r, { image: "data:image/jpeg;base64,aW52YWxpZA==" }));
  assert.equal(r.coverFile, saved);
  assert.ok(fs.existsSync(covers.file(saved)));
});
test("real face frames beat waiting frames, support member photos and original cover priority", { skip: !available || !photo || !fs.existsSync(photo || "") }, async () => {
  const video = path.join(root, "face.mp4");
  await run(ffmpeg, ["-v", "error", "-loop", "1", "-i", photo, "-f", "lavfi", "-i", "color=c=black:s=160x288:d=1", "-filter_complex", "[1:v]setsar=1[wait];[0:v]scale=160:288,setsar=1,trim=duration=2[face];[wait][face]concat=n=2:v=1:a=0[out]", "-map", "[out]", "-t", "3", "-y", video]);
  const r = manager.addRecording({ status: "done", source: "pocket48", memberId: "123", memberName: "SNH48-成员", liveTitle: "今晚一起聊天", filePath: video });
  await covers.generate(r);
  assert.equal(r.coverSource, "smart");
  assert.ok(r.coverTime >= 1);
  await covers.saveMember("123", { memberName: "SNH48-成员", image: `data:image/jpeg;base64,${fs.readFileSync(photo).toString("base64")}` });
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(fs.readFileSync(photo), { headers: { "content-type": "image/jpeg" } });
  try {
    r.liveCoverUrl = "https://source3.48.cn/test.jpg";
    await covers.generate(r, { refresh: true });
    assert.equal(r.coverSource, "original");
    await covers.generate(r, { source: "template" });
    assert.equal(r.coverSource, "template");
    assert.equal(r.coverCandidates.find(c => c.source === "template").reason, "使用成员照片");
  } finally { global.fetch = originalFetch; }
});
