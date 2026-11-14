// Compare a sha256sum-format manifest with the running container's files.
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const manifest = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
let checked = 0, missing = 0, mismatch = 0;
const examples = [];
for (const line of manifest) {
  const match = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
  if (!match) continue;
  const [, expected, rel] = match;
  const file = path.join("/app", rel);
  let actual;
  try {
    actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    missing++;
    if (examples.length < 8) examples.push(`MISSING ${rel}`);
    continue;
  }
  checked++;
  if (actual !== expected) {
    mismatch++;
    if (examples.length < 8) examples.push(`MISMATCH ${rel}`);
  }
}
console.log(`runtime manifest: checked=${checked} missing=${missing} mismatch=${mismatch} total=${manifest.length}`);
for (const line of examples) console.log("  " + line);
