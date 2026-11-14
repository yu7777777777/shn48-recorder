import assert from "node:assert/strict";
import test from "node:test";
import { chooseHlsPlaybackEngine, safeHlsErrorFacts } from "../src/lib/playback.js";

test("hls.js wins when Chromium also claims native HLS support", () => {
  assert.equal(chooseHlsPlaybackEngine({ hlsJsSupported: true, nativeHlsSupported: true }), "hls.js");
});

test("native HLS is the fallback when hls.js is unavailable", () => {
  assert.equal(chooseHlsPlaybackEngine({ hlsJsSupported: false, nativeHlsSupported: true }), "native");
  assert.equal(chooseHlsPlaybackEngine({ hlsJsSupported: false, nativeHlsSupported: false }), null);
});

test("HLS error facts exclude request URLs and response bodies", () => {
  const facts = safeHlsErrorFacts({
    fatal: true,
    type: "networkError",
    details: "manifestLoadError",
    response: { code: 502, url: "/api/public/replay-streams/secret/manifest", text: "private" },
    networkDetails: { status: 502, getResponseHeader: name => name === "content-type" ? "application/json" : null },
  });
  assert.deepEqual(facts, {
    fatal: true,
    type: "networkError",
    details: "manifestLoadError",
    status: 502,
    contentType: "application/json",
  });
  assert.equal(JSON.stringify(facts).includes("secret"), false);
  assert.equal(JSON.stringify(facts).includes("private"), false);
});
