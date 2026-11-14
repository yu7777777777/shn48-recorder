import React from "react";
import { computePeaks, offsetsFromMessages, peakSegments } from "../lib/danmakuPeaks";

const stamp = value => {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, "0")).join(":");
};

// 高能时刻条：原生播放器控件上无法叠加标记，所以在播放器下方渲染一条与
// 时长对齐的密度峰值条。峰值区间可点击跳转（±30s 高亮带），悬停显示
// 时间与弹幕条数。弹幕不会撒谎——峰值就是最直观的高光路标。
export default function DanmakuPeaksBar({ messages, duration, onSeek }) {
  const peaks = computePeaks(offsetsFromMessages(messages), duration);
  if (!peaks.length || !(duration > 0)) return null;
  const segments = peakSegments(peaks, duration);
  const max = Math.max(...peaks.map(peak => peak.count)) || 1;
  return <div className="danmaku-peaks" role="group" aria-label="弹幕高能时刻" style={{ marginTop: 8 }}>
    <div style={{ position: "relative", height: 26, background: "var(--bg-panel, #222)", borderRadius: 6, overflow: "hidden" }}>
      {segments.map(segment => <button
        key={segment.time}
        type="button"
        title={`高能 ${stamp(segment.time)} · ${segment.count} 条弹幕`}
        aria-label={`跳转高能时刻 ${stamp(segment.time)}，${segment.count} 条弹幕`}
        onClick={() => onSeek?.(segment.time)}
        style={{
          position: "absolute",
          left: `${segment.from * 100}%`,
          width: `${Math.max(0.8, (segment.to - segment.from) * 100)}%`,
          top: 0,
          bottom: 0,
          border: "none",
          cursor: "pointer",
          background: `linear-gradient(to top, rgba(255,170,60,${0.25 + 0.55 * (segment.count / max)}) ${segment.at * 100 - segment.from * 100}%, rgba(255,170,60,0.12) ${segment.at * 100 - segment.from * 100}%)`,
        }}
      />)}
      {segments.map(segment => <span
        key={`marker-${segment.time}`}
        aria-hidden
        style={{
          position: "absolute",
          left: `${segment.at * 100}%`,
          top: 0,
          bottom: 0,
          width: 2,
          marginLeft: -1,
          background: "rgba(255,190,90,0.9)",
          pointerEvents: "none",
        }}
      />)}
    </div>
    <small style={{ color: "var(--text-muted)", display: "block", marginTop: 2 }}>
      弹幕高能时刻：{segments.map(segment => `${stamp(segment.time)}（${segment.count}）`).join(" · ")}，点击跳转
    </small>
  </div>;
}
