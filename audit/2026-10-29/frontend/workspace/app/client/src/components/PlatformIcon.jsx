import React from "react";

// Brand marks for the social account book. They are drawn as simple glyphs on a
// tinted tile rather than shipping official logos: the page only needs each
// platform to be distinguishable at a glance next to its name.
const BRANDS = {
  weibo: { label: "微博", short: "微", color: "#e6162d", tint: "#fdecee", glyph: "eye" },
  xiaohongshu: { label: "小红书", short: "书", color: "#ff2442", tint: "#ffedf0", glyph: "book" },
  douyin: { label: "抖音", short: "抖", color: "#0f172a", tint: "#eef2f7", glyph: "note" },
  bilibili: { label: "B站", short: "B", color: "#00a1d6", tint: "#e8f7fd", glyph: "tv" },
  group: { label: "应援群", short: "群", color: "#7c3aed", tint: "#f2ebff", glyph: "users" },
};

export function brandOf(platform) {
  return BRANDS[platform] || { label: platform || "平台", short: "?", color: "#64748b", tint: "#f1f5f9", glyph: "dot" };
}

function Glyph({ glyph, color }) {
  const common = { stroke: color, strokeWidth: 1.8, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" };
  if (glyph === "eye") {
    return (
      <>
        <path d="M4 12c2.2-3.4 4.9-5.1 8-5.1s5.8 1.7 8 5.1c-2.2 3.4-4.9 5.1-8 5.1S6.2 15.4 4 12Z" {...common} />
        <circle cx="12" cy="12" r="2.4" {...common} />
      </>
    );
  }
  if (glyph === "book") {
    return (
      <>
        <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v16H6.5A1.5 1.5 0 0 1 5 18.5Z" {...common} />
        <path d="M8.5 8.5h6M8.5 12h4" {...common} />
      </>
    );
  }
  if (glyph === "note") {
    return (
      <>
        <path d="M9 17.5V6.8l8-1.8v10.2" {...common} />
        <ellipse cx="6.6" cy="17.6" rx="2.4" ry="2" {...common} />
        <ellipse cx="14.6" cy="15.4" rx="2.4" ry="2" {...common} />
      </>
    );
  }
  if (glyph === "tv") {
    return (
      <>
        <rect x="3.5" y="7.5" width="17" height="11.5" rx="2.5" {...common} />
        <path d="M9 4.5 12 7.5l3-3M9 11.5v3.5M15.5 11.5v3.5" {...common} />
      </>
    );
  }
  if (glyph === "users") {
    return (
      <>
        <circle cx="9" cy="9" r="2.6" {...common} />
        <path d="M4 18.5c.6-2.7 2.6-4.2 5-4.2s4.4 1.5 5 4.2" {...common} />
        <path d="M15.4 7.2a2.4 2.4 0 0 1 0 4.6M17 14.6c1.6.5 2.6 1.8 3 3.9" {...common} />
      </>
    );
  }
  return <circle cx="12" cy="12" r="3" {...common} />;
}

export default function PlatformIcon({ platform, size = 34, className = "" }) {
  const brand = brandOf(platform);
  return (
    <span
      className={`sa-brand ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: brand.tint,
        border: `1px solid ${brand.color}22`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24">
        <Glyph glyph={brand.glyph} color={brand.color} />
      </svg>
    </span>
  );
}
