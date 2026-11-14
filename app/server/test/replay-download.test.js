"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");
const media = require("../modules/recorder/replay-download");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-download-"));
const fixture = path.join(root, "fixture"); fs.mkdirSync(fixture);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const creation = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-threads", "1", "-g", "25", "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", path.join(fixture, "index.m3u8")]);
assert.equal(creation.status, 0, creation.stderr?.toString());
const manifest = fs.readFileSync(path.join(fixture, "index.m3u8"), "utf8");
const resources = manifest.split(/\r?\n/).filter(x => x && !x.startsWith("#"));
function response(buffer, statusCode = 200, declared = buffer.length) {
  const stream = Readable.from([buffer]); stream.statusCode = statusCode; stream.headers = { "content-length": String(declared) }; stream.complete = true; return stream;
}
function fake(options = {}) {
  const calls = [];
  const getReplay = async liveId => ({ replay: { liveId }, streamUrl: "https://idol-vod.48.cn/test/index.m3u8" });
  const request = async url => {
    const name = path.basename(new URL(url).pathname); calls.push(name);
    if (options.fail?.(name)) return { response: response(Buffer.from("missing"), 404), finalUrl: url };
    let buffer = name === "index.m3u8" ? Buffer.from(options.manifest || manifest) : fs.readFileSync(path.join(fixture, name));
    const declared = buffer.length;
    if (options.truncate?.(name)) buffer = buffer.subarray(0, buffer.length - 1);
    return { response: response(buffer, 200, declared), finalUrl: url };
  };
  return { calls, getReplay, request };
}
test("downloads all resources before offline mux/decode; cached replay survives upstream deletion", async () => {
  const mock = fake(); let completeBeforeVerification = false;
  const result = await media.download({ liveId: "101", directory: path.join(root, "complete"), ...mock, onProgress(p) {
    if (p.verifying) { completeBeforeVerification = true; assert.equal(p.completed, p.total); assert.equal(mock.calls.length, resources.length + 1); }
  } });
  assert.ok(completeBeforeVerification); assert.equal(result.segments, resources.length);
  assert.ok(result.durationSeconds >= 5.9); assert.ok(result.streams.some(s => s.codec_type === "audio"));
  assert.equal(result.sha256, await media.digest(result.filePath));
  const cache = await media.download({ liveId: "101", directory: path.join(root, "complete"), getReplay: () => { throw new Error("deleted"); }, request: () => { throw new Error("deleted"); } });
  assert.equal(cache.sha256, result.sha256);
  assert.equal(fs.existsSync(path.join(root, "complete", "plan.json")), false);
  const refreshed = fake();
  const updated = await media.download({ liveId: "101", directory: path.join(root, "complete"), ...refreshed, refresh: true });
  assert.equal(updated.timelineVersion, 1);
  assert.ok(refreshed.calls.includes("index.m3u8"));
});
test("public download becomes ready after fast checks, then full validation promotes the same cache", async () => {
  const dir = path.join(root, "fast");
  const fast = await media.download({ liveId: "106", directory: dir, ...fake(), verify: false });
  assert.equal(fast.verification, "fast");
  assert.equal(fs.existsSync(fast.filePath), true);
  const full = await media.download({ liveId: "106", directory: dir, verify: true,
    getReplay: () => { throw new Error("upstream should not be requested again"); },
    request: () => { throw new Error("upstream should not be requested again"); },
  });
  assert.equal(full.verification, "full");
  assert.equal(full.sha256, fast.sha256);
});
test("deletion partway through download never yields a completed replacement; completed resources resume", async () => {
  const dir = path.join(root, "partial");
  const broken = fake({ fail: name => name === resources.at(-1) });
  await assert.rejects(media.download({ liveId: "102", directory: dir, ...broken }), /分片失效|下载失败/);
  assert.equal(fs.existsSync(path.join(dir, "verified.mp4")), false);
  assert.equal(fs.existsSync(path.join(dir, "complete.json")), false);
  const resumed = fake(); await media.download({ liveId: "102", directory: dir, ...resumed });
  assert.deepEqual(resumed.calls, [resources.at(-1)]);
});
test("truncated segment and wrong manifest duration cannot be accepted", async () => {
  await assert.rejects(media.download({ liveId: "103", directory: path.join(root, "truncated"), ...fake({ truncate: name => name === resources[0] }) }), /完整下载/);
  const badDuration = manifest.replace(/#EXTINF:1\.000000/g, "#EXTINF:10.000000");
  await assert.rejects(media.download({ liveId: "104", directory: path.join(root, "duration"), ...fake({ manifest: badDuration }) }), /时长/);
  assert.equal(fs.existsSync(path.join(root, "duration", "verified.mp4")), false);
});
test("unfinalized, missing, cross-host, unsupported and malformed playlists fail closed", () => {
  const scope = () => ({ origin: "https://idol-vod.48.cn", hostname: "idol-vod.48.cn", pathPrefix: "/test/", resourcePathPrefixes: new Set(["/test/"]) });
  const parse = text => media.mediaPlan(text, "https://idol-vod.48.cn/test/index.m3u8", scope());
  assert.throws(() => parse(manifest.replace("#EXT-X-ENDLIST", "")), /完整清单/);
  assert.throws(() => parse(manifest.replace(resources[0], "https://example.com/x.ts")), /allowlisted/);
  assert.throws(() => parse(manifest.replace("#EXT-X-ENDLIST", "#EXT-X-GAP\n#EXT-X-ENDLIST")), /缺失/);
  assert.throws(() => parse("#EXTM3U\n#EXTINF:1,\n#EXT-X-ENDLIST"), /不完整/);
});
test("a cached replay with altered bytes fails checksum verification", async () => {
  const dir = path.join(root, "tamper"); const result = await media.download({ liveId: "105", directory: dir, ...fake() });
  fs.appendFileSync(result.filePath, "tampered");
  await assert.rejects(media.download({ liveId: "105", directory: dir, ...fake() }), /摘要不匹配/);
});

test("reconnect timelines preserve every audio/video packet without collapsing reset timestamps", async () => {
  const body = manifest.split(/\r?\n/).filter(line => line.startsWith("#EXTINF:") || line && !line.startsWith("#")).join("\n");
  const reset = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-DISCONTINUITY\n${body}\n#EXT-X-DISCONTINUITY\n${body}\n#EXT-X-ENDLIST\n`;
  const dir = path.join(root, "reconnect");
  const result = await media.download({ liveId: "108", directory: dir, ...fake({ manifest: reset }) });
  assert.equal(result.segments, resources.length * 2);
  assert.ok(result.durationSeconds >= 11.9 && result.durationSeconds < 12.5);
  const check = JSON.parse(fs.readFileSync(path.join(dir, "validation.json")));
  assert.equal(check.periods.length, 2);
  assert.deepEqual(check.expectedPackets, check.actualPackets);
  assert.ok(check.actualPackets.every(s => s.packets > 0));
  assert.equal(fs.readdirSync(dir).some(n => n.startsWith("timeline-")), false);
  const wrong = reset.replace(/#EXTINF:1\.000000/g, "#EXTINF:10.000000");
  const wrongDir = path.join(root, "bad-reconnect");
  await assert.rejects(media.download({ liveId: "109", directory: wrongDir, ...fake({ manifest: wrong }) }), /清单.*秒.*文件.*秒/);
  const failure = fs.readFileSync(path.join(wrongDir, "validation.json"), "utf8");
  assert.ok(failure.includes('"error"'));
  assert.equal(failure.includes("https:"), false);
  const exaggerated = `#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXT-X-DISCONTINUITY\n#EXTINF:60,\n${resources[0]}\n#EXT-X-ENDLIST\n`;
  await assert.rejects(media.download({ liveId: "110", directory: path.join(root, "single-wrong"), ...fake({ manifest: exaggerated }) }), /时长/);
});

test("timeline split retains implicit AES IV sequence, active keys and init maps across reconnects", () => {
  const periods = media.continuityPeriods('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-KEY:METHOD=AES-128,URI="asset-00000.bin"\n#EXT-X-MAP:URI="asset-00001.mp4"\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nasset-00002.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nasset-00003.ts\n#EXT-X-ENDLIST\n');
  assert.equal(periods.length, 2);
  assert.ok(periods[0].local.includes('#EXT-X-MEDIA-SEQUENCE:9007199254740993'));
  assert.ok(periods[1].local.includes('#EXT-X-MEDIA-SEQUENCE:9007199254740994'));
  assert.ok(periods[1].local.includes('#EXT-X-KEY:METHOD=AES-128,URI="asset-00000.bin"'));
  assert.ok(periods[1].local.includes('#EXT-X-MAP:URI="asset-00001.mp4"'));
  assert.deepEqual(periods.map(p => p.seconds), [6, 5]);
});

test("an audio-only reconnect period preserves all audio and pictures on separate timelines", async () => {
  const audio=spawnSync(process.env.FFMPEG_BIN||"ffmpeg",["-v","error","-y","-f","lavfi","-i","sine=frequency=660:sample_rate=48000","-t","0.4","-c:a","aac","-f","mpegts",path.join(fixture,"audio-only.ts")]);assert.equal(audio.status,0,audio.stderr?.toString());
  const body=manifest.split(/\r?\n/).filter(line=>line.startsWith("#EXTINF:")||line&&!line.startsWith("#")).join("\n");
  const mixed=`#EXTM3U\n#EXT-X-TARGETDURATION:1\n${body}\n#EXT-X-DISCONTINUITY\n#EXTINF:0.4,\naudio-only.ts\n#EXT-X-DISCONTINUITY\n${body}\n#EXT-X-ENDLIST\n`;
  const dir=path.join(root,"audio-reconnect");const result=await media.download({liveId:"111",directory:dir,...fake({manifest:mixed})});
  const v=JSON.parse(fs.readFileSync(path.join(dir,"validation.json")));assert.equal(v.method,"separate_tracks");assert.deepEqual(v.expectedPackets,v.actualPackets);assert.ok(v.audioOnlySeconds>=0.4);
  assert.ok(result.durationSeconds>=12.3&&result.durationSeconds<13.5);assert.equal(result.verification,"full");assert.equal(fs.readdirSync(dir).some(n=>n.startsWith("timeline-")),false);
});
test("plan persistence is throttled: a fast burst does not rewrite per segment and the final flush carries everything", async () => {
  const store = require("../lib/store");
  const originalWrite = store.atomicWrite;
  const planWrites = [];
  store.atomicWrite = (file, value) => { const result = originalWrite(file, value); if (String(file).endsWith("plan.json")) planWrites.push(JSON.parse(JSON.stringify(value))); return result; };
  try {
    const dir = path.join(root, "throttle");
    const result = await media.download({ liveId: "107", directory: dir, ...fake() });
    assert.equal(result.segments, resources.length);
    // Every segment completes inside the 3s throttle window, so apart from the
    // plan creation write exactly one flush lands on disk: the unconditional
    // final one after all workers settled.
    assert.equal(planWrites.length, 2);
    assert.equal(Object.keys(planWrites[0].completed).length, 0);
    assert.equal(Object.keys(planWrites[1].completed).length, resources.length);
    for (const name of Object.keys(planWrites[1].completed)) {
      assert.equal(typeof planWrites[1].completed[name].bytes, "number");
      assert.match(planWrites[1].completed[name].sha256, /^[a-f0-9]{64}$/);
    }
  } finally { store.atomicWrite = originalWrite; }
});
