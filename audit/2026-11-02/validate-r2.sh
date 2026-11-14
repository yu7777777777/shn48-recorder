set -euo pipefail
REL=/opt/shn48/releases/1.32.0
cd "$REL"
test "$(cat build.exit)" = 1
sha256sum -c ARCHIVE-SHA256SUMS-r2
test ! -e stage-r2
mkdir stage-r2
tar -xzf shn48-1.32.0-source-r2.tar.gz -C stage-r2
cd stage-r2
sha256sum -c SOURCE-SHA256SUMS > "$REL/source-verify-r2.log"
python3 - <<'PY'
from pathlib import Path
import re
p=Path('/opt/shn48/releases/1.32.0')
s=(p/'server-tests.log').read_text()
assert '# tests 571\n' in s and '# pass 559\n' in s and '# fail 11\n' in s and '# skipped 1\n' in s
assert re.findall(r'^not ok (\d+) ',s,re.M)==[str(n) for n in range(187,198)]
def manifest(file):return {name:digest for digest,name in (line.split('  ',1) for line in file.read_text().splitlines())}
a=manifest(p/'stage/SOURCE-SHA256SUMS');b=manifest(p/'stage-r2/SOURCE-SHA256SUMS')
assert a.keys()==b.keys()
assert {k for k in a if a[k]!=b[k]}=={'server/test/audit-recorder-regressions.test.js','CHANGELOG.md'}
print('R2_ONLY_TEST_FIX_AND_CHANGELOG; ALL_OTHER_TESTS_PASSED')
PY
mv "$REL/build.exit" "$REL/initial-build.exit"
cat > "$REL/validate-r2-worker.sh" <<'BUILD'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.0
trap 'rc=$?; echo "$rc" > "$REL/build.exit"' EXIT
cd "$REL/stage-r2"
docker tag shn48-shn48:1.32.0 shn48-shn48:1.32.0-before-test-fixture-fix
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 -t shn48-shn48:1.32.0 . > "$REL/image-build-r2.log" 2>&1
docker run --rm --network none --memory=1024m --cpus=1 --entrypoint sh -e DATA_DIR=/tmp/test-data -e RECORDINGS_DIR=/tmp/test-recordings shn48-shn48:1.32.0 -c 'mkdir -p "$DATA_DIR" "$RECORDINGS_DIR"; node --test test/audit-recorder-regressions.test.js' > "$REL/server-tests-r2.log" 2>&1
docker run --rm --network none --memory=1024m --cpus=1 --shm-size=256m --entrypoint sh -e CHROMIUM_PATH=/usr/bin/chromium shn48-frontend-build:1.32.0 -c 'ln -s /app/server /build/server; printf "%s\n" "const {chromium}=require(\"/app/server/node_modules/playwright\");const launch=chromium.launch.bind(chromium);chromium.launch=opts=>launch({...opts,executablePath:\"/usr/bin/chromium\"});" > /tmp/test-browser.cjs; node --require /tmp/test-browser.cjs --test --test-concurrency=1 test/*.test.js' > "$REL/client-tests.log" 2>&1
BUILD
chmod 700 "$REL/validate-r2-worker.sh"
nohup bash "$REL/validate-r2-worker.sh" > "$REL/validate-r2-worker.log" 2>&1 < /dev/null &
echo "VALIDATION_PID=$!"
