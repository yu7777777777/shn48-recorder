import React from "react";

const GROUP_COLORS = {
  SNH: { bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" }, // Blue
  GNZ: { bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" }, // Green
  BEJ: { bg: "#fdf2f8", color: "#be185d", border: "#fbcfe8" }, // Pink
  CKG: { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa" }, // Orange
  IDFT: { bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe" }, // Purple
};

export function TeamBadge({ name }) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  let style = null;
  for (const [key, val] of Object.entries(GROUP_COLORS)) {
    if (upper.includes(key)) {
      style = val;
      break;
    }
  }

  return (
    <span
      className="badge team-badge"
      style={
        style
          ? {
              backgroundColor: style.bg,
              color: style.color,
              borderColor: style.border,
            }
          : undefined
      }
    >
      {name}
    </span>
  );
}

export function StatusBadge({ status, children }) {
  const norm = String(status || "").toLowerCase();
  let badgeClass = "badge-default";

  if (norm.includes("live") || norm === "recording") badgeClass = "badge-recording";
  else if (["done", "completed", "archived", "draft", "ready", "ok", "healthy"].includes(norm))
    badgeClass = "badge-done";
  else if (["queued", "uploading", "processing", "clip_queued", "clip_processing"].includes(norm)) badgeClass = "badge-queued";
  else if (["pending", "waiting_merge", "waiting_credentials", "paused_recording", "warning"].includes(norm))
    badgeClass = "badge-pending";
  else if (["failed", "archive_failed", "clip_failed", "error", "unavailable", "credentials_error"].includes(norm))
    badgeClass = "badge-failed";

  return <span className={`badge ${badgeClass}`}>{children || status}</span>;
}
