"use strict";

const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || process.env.USERPROFILE || "/root";
const DATA_DIR = process.env.DATA_DIR || path.join(HOME, ".shn48-data");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  ensureDir();
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name, fallback) {
  try {
    const fp = filePath(name);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) { console.error(`[store] load ${name} error:`, e.message); }
  return fallback;
}

// Write JSON through a unique temporary file so a crash or full disk can never
// leave a half-written file at the destination. Throws on failure; the caller
// decides how to surface it.
function atomicWrite(destination, data) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let temporary;
  try {
    temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, destination);
  } catch (e) {
    if (temporary) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
    throw e;
  }
}

function save(name, data) {
  try {
    atomicWrite(filePath(name), data);
  } catch (e) {
    console.error(`[store] save ${name} error:`, e.message);
  }
}

module.exports = { load, save, atomicWrite, filePath, dataDir: DATA_DIR, ensureDir };
