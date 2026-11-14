set -euo pipefail
REL=/opt/shn48/releases/1.32.2
cd "$REL"
test "$(cat build.exit)" = 0
cp build.exit validation-before-r3.exit
printf 'pending\n' > build.exit
sha256sum -c ARCHIVE-SHA256SUMS-r3
mkdir stage-r3
tar -xzf shn48-1.32.2-replay-patch-r3.tar.gz -C stage-r3
cd stage-r3
sha256sum -c SOURCE-SHA256SUMS > "$REL/source-verify-r3.log"
cat > "$REL/final-build-worker.sh" <<'BUILD'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.2
trap 'rc=$?; echo "$rc" > "$REL/build.exit"' EXIT
cd "$REL/stage-r3"
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 -t shn48-shn48:1.32.2-final . > "$REL/image-build-final.log" 2>&1
docker run --rm --network none --memory=768m --cpus=1 --entrypoint sh shn48-shn48:1.32.2-final -c 'cd /app/server; DATA_DIR=/tmp/test-data RECORDINGS_DIR=/tmp/test-recordings node --test --test-concurrency=1 test/replay*.test.js test/archive*.test.js' > "$REL/server-tests-final.log" 2>&1
docker tag shn48-shn48:1.32.2 shn48-shn48:1.32.2-before-cache-fix
docker tag shn48-shn48:1.32.2-final shn48-shn48:1.32.2
docker image inspect shn48-shn48:1.32.2 --format '{{.Id}}' > "$REL/candidate-image-id.txt"
docker run --rm --network none --entrypoint sh shn48-shn48:1.32.2 -c 'cd /app; find server client/dist -type f ! -path "*/node_modules/*" -exec sha256sum {} +; sha256sum VERSION' | sort -k2 > "$REL/RUNTIME-SHA256SUMS"
python3 - <<'PY'
from pathlib import Path
import re
root=Path('/opt/shn48/releases')
def load(p):return {name:digest for digest,name in (line.split('  ',1) for line in p.read_text().splitlines())}
a=load(root/'1.32.1/RUNTIME-SHA256SUMS');b=load(root/'1.32.2/RUNTIME-SHA256SUMS');source=load(root/'1.32.2/stage-r3/SOURCE-SHA256SUMS');initial=load(root/'1.32.2/stage/SOURCE-SHA256SUMS')
changed={'server/package.json','server/package-lock.json','server/modules/recorder/replay-download.js','server/modules/recorder/replay-audit.js','server/test/replay-download.test.js','server/test/replay-audit.test.js','VERSION'}
for name,digest in a.items():
 if name.startswith('server/') and name not in changed:assert b[name]==digest,name
for name in changed:assert source[name]==b[name],name
for name in source:
 if name.startswith('client/'):assert source[name]==initial[name],name
for filename,expected in [('server-tests-final.log',74),('client-tests-configured.log',166)]:
 text=(root/'1.32.2'/filename).read_text()
 assert re.search(r'^# pass '+str(expected)+r'$',text,re.M),filename
 assert re.search(r'^# fail 0$',text,re.M),filename
print('FINAL_SOURCE_HASHES_VERIFIED; FRONTEND_UNCHANGED; ALL_TESTS_PASSED')
PY
BUILD
nohup bash "$REL/final-build-worker.sh" > "$REL/final-build-worker.log" 2>&1 < /dev/null &
echo FINAL_BUILD_PID=$!
