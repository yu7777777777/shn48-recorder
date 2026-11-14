set -euo pipefail
REL=/opt/shn48/releases/1.32.2
test "$(cat "$REL/build.exit")" = 1
cp "$REL/build.exit" "$REL/initial-build.exit"
cat > "$REL/validation-worker.sh" <<'BUILD'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.2
trap 'rc=$?; echo "$rc" > "$REL/build.exit"' EXIT
docker run --rm --network none --memory=768m --cpus=1 --shm-size=256m --entrypoint sh -v /opt/shn48/releases/1.32.0/browser-test-preload.cjs:/tmp/test-browser.cjs:ro shn48-frontend-build:1.32.2 -c 'ln -s /app/server /build/server; cd /build/client; node --require /tmp/test-browser.cjs --test --test-concurrency=1 test/*.test.js' > "$REL/client-tests-configured.log" 2>&1
docker image inspect shn48-shn48:1.32.2 --format '{{.Id}}' > "$REL/candidate-image-id.txt"
docker run --rm --network none --entrypoint sh shn48-shn48:1.32.2 -c 'cd /app; find server client/dist -type f ! -path "*/node_modules/*" -exec sha256sum {} +; sha256sum VERSION' | sort -k2 > "$REL/RUNTIME-SHA256SUMS"
python3 - <<'PY'
from pathlib import Path
def load(p):return {name:digest for digest,name in (line.split('  ',1) for line in p.read_text().splitlines())}
root=Path('/opt/shn48/releases');a=load(root/'1.32.1/RUNTIME-SHA256SUMS');b=load(root/'1.32.2/RUNTIME-SHA256SUMS');source=load(root/'1.32.2/stage/SOURCE-SHA256SUMS')
changed={'server/package.json','server/package-lock.json','server/modules/recorder/replay-download.js','server/modules/recorder/replay-audit.js','server/test/replay-download.test.js','server/test/replay-audit.test.js','VERSION'}
for name,digest in a.items():
 if name.startswith('server/') and name not in changed:assert b[name]==digest,name
for name in changed:assert source[name]==b[name],name
print('ONLY_DECLARED_BACKEND_FILES_CHANGED')
PY
BUILD
test -f /opt/shn48/releases/1.32.0/browser-test-preload.cjs
nohup bash "$REL/validation-worker.sh" > "$REL/validation-worker.log" 2>&1 < /dev/null &
echo "VALIDATION_PID=$!"
