"use strict";
// Link previews for shared pages. Social apps read Open Graph tags from the
// static shell, but the shell is one file for the whole SPA, so the server
// rewrites only the tags that describe a shared replay page.
function escape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\r?\n/g, " ").slice(0, 300);
}
function text(value, limit) {
  const clean = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}
// Returns the tags to swap in, or null when the page is not a shared replay.
function tagsFor(pathname, lookup) {
  const match = /^\/replays\/([A-Za-z0-9_-]{1,64})\/?$/.exec(String(pathname || ""));
  if (!match) return null;
  const found = lookup(match[1]);
  // A missing or unpublished replay keeps the generic tags: a 404 would make
  // every chat client cache a broken card for the whole site.
  if (!found) return null;
  const title = text(found.title || "回放", 80) + " · 回放总结";
  const description = text(found.summary || "查看这条回放的章节与精彩片段。", 180);
  return { title: escape(title), description: escape(description) };
}
function inject(html, tags) {
  if (!tags) return html;
  const head = [
    `<meta property="og:title" content="${tags.title}" />`,
    `<meta property="og:description" content="${tags.description}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");
  // Replace the generic ones so a client never reads two conflicting titles.
  return String(html)
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${tags.title}</title>`)
    .replace("</head>", `    ${head}\n  </head>`);
}
module.exports = { tagsFor, inject, escape, text };
