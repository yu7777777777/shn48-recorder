// Verify the generated hash manifests against the working tree.
// ESM module (`.mjs`), so imports rather than require.
import fs from "node:fs";
import crypto from "node:crypto";

let failures = 0;

for (const manifest of ["SHA256SUMS", "RUNTIME-SHA256SUMS"]) {
  if (!fs.existsSync(manifest)) {
    console.log(`MISSING manifest: ${manifest}`);
    failures++;
    continue;
  }

  let checked = 0;
  let bad = 0;

  for (const line of fs.readFileSync(manifest, "utf8").split("\n")) {
    if (!line.trim()) continue;

    // sha256sum format: "<64 hex><two spaces><path>"
    const match = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
    if (!match) {
      console.log(`  MALFORMED LINE in ${manifest}: ${JSON.stringify(line)}`);
      bad++;
      continue;
    }

    const [, expected, file] = match;
    checked++;

    try {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (actual !== expected) {
        console.log(`  MISMATCH ${file}`);
        console.log(`    manifest: ${expected}`);
        console.log(`    actual:   ${actual}`);
        bad++;
      }
    } catch (error) {
      console.log(`  UNREADABLE ${file}: ${error.code || error.message}`);
      bad++;
    }
  }

  console.log(`${manifest}: checked ${checked}, problems ${bad}`);
  failures += bad;
}

console.log(failures === 0 ? "PASS manifests are consistent" : `FAIL ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
