import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Pins the VERSION resolution order used to stamp __APP_VERSION__ at build time.
//
// `./VERSION` must win over `../VERSION`. During 1.17.7 packaging the bundle root
// was the client directory, so `../VERSION` resolved to a stale file outside the
// bundle and the build was labelled 1.17.6 while every intended input said 1.17.7.
// That failure is silent: the build succeeds and the badge simply shows a wrong,
// slightly older version, which is exactly the drift this resolver exists to stop.

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vite.config.js");
const configSource = readFileSync(configPath, "utf8");

// Mirrors resolveVersion in vite.config.js.
function resolveVersion(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const candidate of ["./VERSION", "../VERSION"]) {
    try {
      const value = readFileSync(path.join(dir, candidate), "utf8").trim();
      if (value) return value;
    } catch { /* fall through to the next candidate, then the manifest */ }
  }
  return pkg.version || "0.0.0";
}

// Builds a temp tree shaped like a release bundle: client files in `client/`,
// optionally a VERSION in each of the two places the resolver looks.
function setup({ own, parent, pkg }) {
  const root = mkdtempSync(path.join(tmpdir(), "ver-"));
  const client = path.join(root, "client");
  mkdirSync(client, { recursive: true });
  writeFileSync(path.join(client, "package.json"), JSON.stringify({ name: "x", version: pkg }));
  if (own) writeFileSync(path.join(client, "VERSION"), own);
  if (parent) writeFileSync(path.join(root, "VERSION"), parent);
  return { root, client };
}

function withTree(options, run) {
  const { root, client } = setup(options);
  try {
    run(client);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the resolver checks ./VERSION before ../VERSION", () => {
  // Order is the whole point; swapping it reintroduces the 1.17.7 packaging bug.
  const order = configSource.match(/\["([^"]*VERSION)",\s*"([^"]*VERSION)"\]/);
  assert.ok(order, "expected a VERSION candidate list in vite.config.js");
  assert.equal(order[1], "./VERSION");
  assert.equal(order[2], "../VERSION");
});

test("a stale parent VERSION does not override the adjacent one", () => {
  // The exact 1.17.7 situation: adjacent 1.17.7, parent 1.17.6.
  withTree({ own: "1.17.7\n", parent: "1.17.6\n", pkg: "1.17.7" }, client => {
    assert.equal(resolveVersion(client), "1.17.7");
  });
});

test("without an adjacent VERSION the parent one is used", () => {
  withTree({ parent: "1.17.7\n", pkg: "1.17.7" }, client => {
    assert.equal(resolveVersion(client), "1.17.7");
  });
});

test("with no VERSION file at all it falls back to package.json", () => {
  withTree({ pkg: "1.17.7" }, client => {
    assert.equal(resolveVersion(client), "1.17.7");
  });
});

test("whitespace in VERSION is trimmed", () => {
  withTree({ own: "  1.17.7\n", pkg: "0.0.0" }, client => {
    assert.equal(resolveVersion(client), "1.17.7");
  });
});

test("an empty VERSION file is skipped in favour of the next candidate", () => {
  withTree({ own: "   \n", parent: "1.17.7\n", pkg: "0.0.0" }, client => {
    assert.equal(resolveVersion(client), "1.17.7");
  });
});
