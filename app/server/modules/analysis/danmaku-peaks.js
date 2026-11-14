"use strict";

// Danmaku density peaks ("高能时刻"). Live danmaku captured during a recording
// is stored by room-voice as voice_messages_<id>; offsets are seconds from the
// audio/video start, which is exactly the player timeline. Peaks computed here
// feed both the progress-bar markers (client computes its own view) and the AI
// highlight candidates (this module, via insights).

// 弹幕不会撒谎：密度峰值是高光最便宜的证据。分桶 → 求均值/标准差 →
// 显著高于均值（默认 mean + 1.5σ）的桶合并成峰值，最多返回 topN 个。
function computePeaks(offsets, duration, options = {}) {
  const bucketSeconds = clamp(Number(options.bucketSeconds) || 30, 10, 300);
  const minGap = clamp(Number(options.minGapSeconds) || 60, 0, 3600);
  const topN = clamp(Number(options.topN) || 8, 1, 30);
  const sigma = Number.isFinite(options.sigma) ? Number(options.sigma) : 1.5;
  if (!Array.isArray(offsets) || offsets.length < 5) return [];
  const span = Number.isFinite(duration) && duration > 0 ? duration : Math.max(...offsets);
  const buckets = Math.max(1, Math.ceil(span / bucketSeconds));
  const counts = new Array(buckets).fill(0);
  for (const raw of offsets) {
    const offset = Number(raw);
    if (!Number.isFinite(offset) || offset < 0 || offset > span + bucketSeconds) continue;
    counts[Math.min(buckets - 1, Math.floor(offset / bucketSeconds))] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total) return [];
  const mean = total / buckets;
  const variance = counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / buckets;
  const threshold = mean + sigma * Math.sqrt(variance);
  // A peak must at least beat a quiet room by an absolute margin too: in an
  // evenly busy room every bucket clears mean + 1.5σ of a tiny σ.
  const absoluteFloor = Math.max(3, mean * 2);
  const candidates = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    if (counts[bucket] < threshold || counts[bucket] < absoluteFloor) continue;
    candidates.push({ time: bucket * bucketSeconds, count: counts[bucket] });
  }
  // Adjacent hot buckets merge into one peak anchored at the busiest bucket.
  const peaks = [];
  for (const candidate of candidates.sort((a, b) => a.time - b.time)) {
    const last = peaks[peaks.length - 1];
    if (last && candidate.time - last.time < minGap) {
      if (candidate.count > last.count) { last.count = candidate.count; last.time = candidate.time; }
      continue;
    }
    peaks.push({ time: candidate.time, count: candidate.count });
  }
  return peaks.sort((a, b) => b.count - a.count).slice(0, topN).sort((a, b) => a.time - b.time);
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

// Read a recording's captured room messages and reduce them to offsets.
// Any failure (no messages, audio-only archive without roomId, missing rows)
// yields [] — peaks are an enhancement, never a hard dependency.
function fromRecording(recordingId, duration) {
  try {
    const rows = require("../pocket48/room-voice").messages(recordingId);
    if (!Array.isArray(rows) || !rows.length) return [];
    const offsets = [];
    for (const row of rows) {
      const offset = Number(row?.offset);
      if (Number.isFinite(offset) && offset >= 0) offsets.push(offset);
    }
    return computePeaks(offsets, duration);
  } catch {
    return [];
  }
}

module.exports = { computePeaks, fromRecording, _internals: { clamp } };
