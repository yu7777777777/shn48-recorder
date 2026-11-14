import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, value) => fs.writeFileSync(path.join(root, p), value);

// Files that must carry the literal version, and are rewritten by `set`.
//
// Several sources no longer hardcode it and are deliberately absent:
// server/index.js, server/routes/public.js, server/modules/pocket48/members.js
// resolve it at runtime from VERSION (server/lib/version.js), and the three
// client components receive it at build time via __APP_VERSION__ (vite.config.js).
// Listing them here would make `check` fail the moment they stop containing the
// literal, which is exactly what they now do.
const textFiles = ['Dockerfile', 'Dockerfile.release', 'README.md', 'client/index.html',
  'client/src/App.css', 'scripts/smoke-test.mjs', 'docker-compose.yml'];

const current = read('VERSION').trim();
const [command = 'check', next] = process.argv.slice(2);

function writeManifest(dir, name, nextVersion) {
  const file = `${dir}/${name}`, data = JSON.parse(read(file));
  data.version = nextVersion;
  if (data.packages?.['']) data.packages[''].version = nextVersion;
  if (data.description) data.description = data.description.replaceAll(current, nextVersion);
  write(file, JSON.stringify(data, null, 2) + '\n');
}

if (command === 'set') {
  if (!/^\d+\.\d+\.\d+$/.test(next || '')) throw new Error('Usage: node scripts/version.mjs set X.Y.Z');
  const a = current.split('.').map(Number), b = next.split('.').map(Number);
  const changed = b.findIndex((v, i) => v !== a[i]);
  if (changed < 0 || b[changed] < a[changed]) throw new Error('Version must increase');
  for (const file of textFiles) write(file, read(file).replaceAll(current, next));
  for (const dir of ['client', 'server']) {
    for (const name of ['package.json', 'package-lock.json']) writeManifest(dir, name, next);
  }
  write('VERSION', next + '\n');
  console.log(`Version ${current} -> ${next}. Update CHANGELOG.md, build, test and regenerate the release manifest before deploying.`);
} else if (command === 'check') {
  for (const dir of ['client', 'server']) {
    for (const name of ['package.json', 'package-lock.json']) {
      const data = JSON.parse(read(`${dir}/${name}`));
      if (data.version !== current || (data.packages?.[''] && data.packages[''].version !== current)) throw new Error(`${dir}/${name}: version mismatch`);
    }
  }
  for (const file of textFiles) if (!read(file).includes(current)) throw new Error(`${file}: missing ${current}`);
  if (!read('CHANGELOG.md').includes(`## [${current}]`)) throw new Error('Missing changelog entry');
  // The resolvers replace the literals that used to live in source, so assert
  // they are still wired: the health endpoint post-deploy verification reads
  // depends on server/lib/version.js finding VERSION.
  if (!read('server/lib/version.js').includes('VERSION')) throw new Error('server/lib/version.js: no longer resolves VERSION');
  if (!read('client/vite.config.js').includes('__APP_VERSION__')) throw new Error('client/vite.config.js: no longer defines __APP_VERSION__');
  console.log(`PASS version ${current}: manifests, image, docs, runtime resolvers and changelog`);
} else throw new Error('Expected check or set');
