"use strict";

// Single source of truth for the release version.
//
// The version used to be spelled out as a literal in several unrelated places
// (the two health endpoints, the startup banner, the "frontend not built" page
// and the Pocket48 User-Agent). They drift silently: a release that forgets one
// leaves `/api/public/health` reporting the previous version, which is exactly
// what post-deploy verification reads. Resolve it once, from the files that
// already exist for the purpose.
const fs = require("fs");
const path = require("path");

const FALLBACK = "0.0.0";

let cached = null;

function readVersionFile() {
  // `VERSION` is copied to /app/VERSION in the image and sits at the root of the
  // release directory, i.e. two levels above this file (`server/lib` -> `server`
  // -> release root). The nearer candidates cover a layout that keeps a copy
  // beside the server package.
  const candidates = [
    path.join(__dirname, "..", "VERSION"),
    path.join(__dirname, "..", "..", "VERSION"),
    path.join(process.cwd(), "VERSION"),
    path.join(process.cwd(), "..", "VERSION"),
  ];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function readPackageVersion() {
  // `lib/` sits inside `server/`, so the manifest is one directory up.
  try {
    return require("../package.json").version || null;
  } catch {
    return null;
  }
}

function version() {
  if (cached) return cached;
  cached = readVersionFile() || readPackageVersion() || FALLBACK;
  return cached;
}

module.exports = { version };
