#!/bin/bash
# Verify the staged 1.17.6 tree on the server before any test or build runs.
set -u

STAGE=/opt/shn48/releases/1.17.6/staged
cd "$STAGE" || { echo "staging directory missing: $STAGE"; exit 1; }

echo "=== 文件总数 ==="
find . -type f | wc -l

echo
echo "=== 关键文件存在性 ==="
for f in \
  VERSION CHANGELOG.md README.md docker-compose.yml Dockerfile Dockerfile.release \
  server/index.js server/lib/version.js server/lib/cli.js \
  server/routes/config.js server/routes/public.js \
  server/modules/analysis/offline.js server/modules/analysis/service.js \
  server/modules/pocket48/members.js \
  client/vite.config.js client/index.html client/src/index.css client/src/App.css \
  client/src/lib/api.js client/src/components/AuthGuard.jsx \
  client/src/components/AdminLayout.jsx \
  client/src/pages/PublicLive.jsx client/src/pages/PublicReplay.jsx ; do
  if [ -f "$f" ]; then echo "  OK    $f"; else echo "  MISS  $f"; fi
done

echo
echo "=== VERSION ==="
cat VERSION

echo "=== 运行时版本解析点 ==="
grep -c 'APP_VERSION' server/index.js server/routes/public.js server/modules/pocket48/members.js
grep -c '__APP_VERSION__' client/vite.config.js client/src/components/AdminLayout.jsx

echo
echo "=== 残留硬编码版本号（源文件应为 0）==="
grep -rn '1\.17\.[0-9]' server/index.js server/routes/public.js \
  server/modules/pocket48/members.js client/src/components/AdminLayout.jsx \
  client/src/pages/PublicLive.jsx client/src/pages/PublicReplay.jsx 2>/dev/null \
  | grep -v '^Binary' || echo "  无 ✅"

echo
echo "=== B1 修复点：offline.js 的 gate ==="
grep -n 'listActive\|WAIT_RECORDING\|setInterval' server/modules/analysis/offline.js || echo "  未找到"

echo
echo "=== H5 修复点：cli.js 超时 ==="
grep -n 'timeoutMs\|DEFAULT_TIMEOUT_MS\|SIGKILL' server/lib/cli.js | head -12

echo
echo "=== H6 修复点：config.js 原子写 ==="
grep -n 'renameSync\|fsyncSync\|\.tmp' server/routes/config.js | head -10
