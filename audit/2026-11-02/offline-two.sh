set -eu
REL=/opt/shn48/releases/1.32.4
docker image inspect shn48-shn48:1.32.4 > /dev/null
cat > "$REL/offline-worker.sh" <<'WORKER'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.4
trap 'rc=$?; echo "$rc" > "$REL/offline.exit"' EXIT
docker run --rm --name shn48-offline-1.32.4 --network none --memory=512m --cpus=1 \
  -v /opt/shn48/runtime/data/.replay-repair-two-20261102:/app/data/.replay-repair-two-20261102 \
  -v "$REL/offline-two.js:/tmp/offline-two.js:ro" --entrypoint node shn48-shn48:1.32.4 /tmp/offline-two.js > "$REL/offline-validation.jsonl" 2> "$REL/offline-validation.err"
WORKER
nohup bash "$REL/offline-worker.sh" > "$REL/offline-worker.log" 2>&1 < /dev/null &
echo OFFLINE_PID=$!
