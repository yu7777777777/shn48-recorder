set -eu
REL=/opt/shn48/releases/1.32.4
cat > "$REL/focused-worker.sh" <<'WORKER'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.4
trap 'rc=$?; echo "$rc" > "$REL/focused.exit"' EXIT
docker run --rm --name shn48-focused-1.32.4 --network none --memory=768m --cpus=1 --entrypoint sh shn48-shn48:1.32.4 -c 'cd /app/server; DATA_DIR=/tmp/test-data RECORDINGS_DIR=/tmp/test-recordings node --test --test-concurrency=1 test/replay-download.test.js test/replay-audit.test.js' > "$REL/focused-tests.log" 2>&1
docker run --rm --network none --entrypoint sh shn48-frontend-build:1.32.4 -c 'cd /build/client; node --test test/replay-import-ui.test.js' > "$REL/frontend-tests.log" 2>&1
docker image inspect shn48-shn48:1.32.4 --format '{{.Id}}' > "$REL/candidate-image-id.txt"
docker run --rm --network none --entrypoint sh shn48-shn48:1.32.4 -c 'cd /app; find server client/dist -type f ! -path "*/node_modules/*" -exec sha256sum {} +; sha256sum VERSION' | sort -k2 > "$REL/RUNTIME-SHA256SUMS"
python3 - <<'PY'
from pathlib import Path
root=Path('/opt/shn48/releases')
def load(p):return {name:digest for digest,name in (line.split('  ',1) for line in p.read_text().splitlines())}
a=load(root/'1.32.3/RUNTIME-SHA256SUMS');b=load(root/'1.32.4/RUNTIME-SHA256SUMS');s=load(root/'1.32.4/stage/SOURCE-SHA256SUMS')
changes={'server/package.json','server/package-lock.json','server/modules/recorder/replay-audit.js','server/modules/recorder/replay-download.js','server/modules/recorder/replay-timeline-tracks.js','server/test/replay-download.test.js','server/test/replay-audit.test.js','VERSION'}
for name,digest in a.items():
 if name.startswith('server/') and name not in changes:assert b[name]==digest,name
for name in changes:assert s[name]==b[name],name
print('ONLY_REPLAY_REPAIR_AND_VERSION_CHANGED')
PY
WORKER
nohup bash "$REL/focused-worker.sh" > "$REL/focused-worker.log" 2>&1 < /dev/null &
echo FOCUSED_PID=$!
