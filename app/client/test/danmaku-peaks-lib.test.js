import test from "node:test";
import assert from "node:assert/strict";
import { computePeaks, offsetsFromMessages, peakSegments } from "../src/lib/danmakuPeaks.js";

test("computePeaks finds the dense window, merges neighbours and caps topN", () => {
  const offsets = [];
  for (let t = 120; t < 180; t += 0.5) offsets.push(t);
  for (let t = 0; t < 600; t += 40) offsets.push(t);
  const peaks = computePeaks(offsets, 600);
  assert.ok(peaks.length >= 1);
  assert.ok(peaks[0].time >= 90 && peaks[0].time <= 210, "the dense window wins");
  // topN is honoured and the result stays time-ordered.
  assert.ok(peaks.length <= 8);
  for (let i = 1; i < peaks.length; i += 1) assert.ok(peaks[i].time > peaks[i - 1].time);
});

test("computePeaks refuses thin or perfectly even data", () => {
  assert.deepEqual(computePeaks([], 600), []);
  assert.deepEqual(computePeaks([1, 2, 3], 600), []);
  const even = [];
  for (let t = 0; t < 600; t += 5) even.push(t);
  assert.deepEqual(computePeaks(even, 600), []);
});

test("offsetsFromMessages keeps only finite non-negative offsets", () => {
  assert.deepEqual(offsetsFromMessages([{ offset: 1.5 }, { offset: -2 }, { offset: "x" }, {}, null]), [1.5]);
  assert.deepEqual(offsetsFromMessages("nope"), []);
});

test("peakSegments maps peaks onto progress-bar fractions with a highlight window", () => {
  const segments = peakSegments([{ time: 300, count: 42 }], 600, { windowSeconds: 30 });
  assert.equal(segments.length, 1);
  const segment = segments[0];
  assert.equal(segment.at, 0.5);
  assert.equal(segment.from, 0.45);
  assert.equal(segment.to, 0.55);
  // Clamping at the edges: a peak near 0 never produces a negative start.
  const edge = peakSegments([{ time: 5, count: 9 }], 600)[0];
  assert.equal(edge.from, 0);
  assert.deepEqual(peakSegments([], 600), []);
  assert.deepEqual(peakSegments([{ time: 1, count: 1 }], 0), [], "no duration means no mapping");
});
