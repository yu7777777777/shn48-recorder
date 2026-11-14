import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

for (const workspace of ["client", "server"]) {
  const cwd = path.join(projectDir, workspace);
  console.log(`Generating ${workspace}/package-lock.json ...`);
  const result = spawnSync(
    npmCommand,
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd, stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Lockfiles generated. Review and commit both package-lock.json files.");
