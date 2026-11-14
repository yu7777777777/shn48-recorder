import React from "react";

export default function ProgressBar({
  percent = 0,
  tone = "primary", // "primary" | "success" | "warning" | "danger" | "info"
  height = 6,
  showLabel = false,
  animated = false,
}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

  return (
    <div className="progress-bar-wrapper">
      <div
        className={`progress-track ${animated ? "animated" : ""}`}
        style={{ height: `${height}px` }}
      >
        <div
          className={`progress-fill tone-${tone}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && <span className="progress-label">{clamped.toFixed(0)}%</span>}
    </div>
  );
}
