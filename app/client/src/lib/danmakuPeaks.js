// 弹幕高能时刻：把录制期抓到的房间消息按 offset 分桶，找密度峰值。
// 与服务端 analysis/danmaku-peaks.js 同一套规则（供 AI 高光候选），
// 前端这份只服务进度条标记，可独立单测。

export function computePeaks(offsets, duration, { bucketSeconds = 30, minGapSeconds = 60, sigma = 1.5, topN = 8 } = {}) {
  if (!Array.isArray(offsets) || offsets.length < 5) return [];
  const span = Number.isFinite(duration) && duration > 0 ? duration : Math.max(...offsets);
  if (!(span > 0)) return [];
  const bucket = Math.max(10, Math.min(300, Number(bucketSeconds) || 30));
  const buckets = Math.max(1, Math.ceil(span / bucket));
  const counts = new Array(buckets).fill(0);
  for (const raw of offsets) {
    const offset = Number(raw);
    if (!Number.isFinite(offset) || offset < 0 || offset > span + bucket) continue;
    counts[Math.min(buckets - 1, Math.floor(offset / bucket))] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total) return [];
  const mean = total / buckets;
  const std = Math.sqrt(counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / buckets);
  const threshold = mean + (Number.isFinite(sigma) ? sigma : 1.5) * std;
  const floor = Math.max(3, mean * 2);
  const candidates = [];
  counts.forEach((count, index) => {
    if (count >= threshold && count >= floor) candidates.push({ time: index * bucket, count });
  });
  const minGap = Math.max(0, Number(minGapSeconds) || 0);
  const merged = [];
  for (const candidate of candidates.sort((a, b) => a.time - b.time)) {
    const last = merged[merged.length - 1];
    if (last && candidate.time - last.time < minGap) {
      if (candidate.count > last.count) { last.count = candidate.count; last.time = candidate.time; }
      continue;
    }
    merged.push({ ...candidate });
  }
  return merged.sort((a, b) => b.count - a.count).slice(0, Math.max(1, Math.min(30, Number(topN) || 8))).sort((a, b) => a.time - b.time);
}

// messages: 录制期消息行（含 offset 秒）→ offsets
export function offsetsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const offsets = [];
  for (const row of messages) {
    const offset = Number(row?.offset);
    if (Number.isFinite(offset) && offset >= 0) offsets.push(offset);
  }
  return offsets;
}

// 峰值 → 进度条百分比位置（含 ±windowSeconds 高亮区间）
export function peakSegments(peaks, duration, { windowSeconds = 30 } = {}) {
  const span = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (!span || !Array.isArray(peaks)) return [];
  return peaks.map(peak => ({
    time: Math.min(Math.max(0, peak.time), span),
    count: peak.count,
    from: Math.max(0, (peak.time - windowSeconds) / span),
    to: Math.min(1, (peak.time + windowSeconds) / span),
    at: Math.min(1, peak.time / span),
  }));
}
