import React from "react";

const GROUP_KEYS = ["SNH", "GNZ", "BEJ", "CKG", "CGT"];

export function detectGroupKey(value) {
  if (!value) return "";
  const upper = String(value).toUpperCase();
  for (const key of GROUP_KEYS) {
    if (upper.includes(key)) return key.toLowerCase();
  }
  if (upper.includes("TEAM CII") || upper.includes("TEAM GII")) return "cgt";
  if (upper.includes("TEAM S") || upper.includes("TEAM N") || upper.includes("TEAM H") || upper.includes("TEAM X")) return "snh";
  if (upper.includes("TEAM G") || upper.includes("TEAM Z")) return "gnz";
  if (upper.includes("TEAM B") || upper.includes("TEAM E")) return "bej";
  if (upper.includes("TEAM C") || upper.includes("TEAM K")) return "ckg";
  return "";
}

export function TeamBadge({ name }) {
  if (!name) return null;
  const groupKey = detectGroupKey(name);
  const toneClass = groupKey ? `badge-team-${groupKey}` : "badge-default";
  return <span className={`badge team-badge ${toneClass}`}>{name}</span>;
}

export function StatusBadge({ status, children }) {
  const norm = String(status || "").toLowerCase();
  let badgeClass = "badge-default";

  if (norm.includes("live") || norm === "recording") badgeClass = "badge-recording";
  else if (["done", "completed", "archived", "draft", "ready", "ok", "healthy"].includes(norm))
    badgeClass = "badge-done";
  else if (["queued", "uploading", "processing", "clip_queued", "clip_processing"].includes(norm))
    badgeClass = "badge-queued";
  else if (["pending", "waiting_merge", "waiting_credentials", "paused_recording", "warning"].includes(norm))
    badgeClass = "badge-pending";
  else if (["failed", "archive_failed", "clip_failed", "error", "unavailable", "credentials_error"].includes(norm))
    badgeClass = "badge-failed";

  return <span className={`badge ${badgeClass}`}>{children || status}</span>;
}
