import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
const files = [];
function walk(relative = '') {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const p = path.posix.join(relative, entry.name);
    if (['node_modules', '.git', 'runtime', 'release', '__pycache__'].includes(entry.name) || entry.name.endsWith('.pyc') || entry.name.startsWith('.env') && entry.name !== '.env.example' || p === 'config/config.yaml' || p === 'SHA256SUMS' || p === 'RUNTIME-SHA256SUMS' || p.startsWith('docs/releases/') || entry.name.endsWith('.log')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${p}`);
    if (entry.isDirectory()) walk(p); else files.push(p);
  }
}
walk(); files.sort();
const runtime = files.filter(p => p.startsWith('server/') || p.startsWith('client/dist/') || p === 'VERSION');
fs.writeFileSync(path.join(root, 'SHA256SUMS'), files.map(p => `${hash(p)}  ${p}\n`).join(''));
fs.writeFileSync(path.join(root, 'RUNTIME-SHA256SUMS'), runtime.map(p => `${hash(p)}  ${p}\n`).join(''));
console.log(`Wrote ${files.length} source/artifact hashes and ${runtime.length} runtime hashes; verify entrypoint.sh separately at /entrypoint.sh.`);
