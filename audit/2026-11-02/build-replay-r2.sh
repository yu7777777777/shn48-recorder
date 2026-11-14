set -euo pipefail
REL=/opt/shn48/releases/1.32.2
cd "$REL"
sha256sum -c ARCHIVE-SHA256SUMS-r2
mkdir stage-r2
tar -xzf shn48-1.32.2-replay-patch-r2.tar.gz -C stage-r2
cd stage-r2
sha256sum -c SOURCE-SHA256SUMS > "$REL/source-verify-r2.log"
python3 - <<'PY'
from pathlib import Path
root=Path('/opt/shn48/releases/1.32.2')
def load(p):return {name:digest for digest,name in (line.split('  ',1) for line in p.read_text().splitlines())}
a=load(root/'stage/SOURCE-SHA256SUMS');b=load(root/'stage-r2/SOURCE-SHA256SUMS')
assert a.keys()==b.keys()
assert {n for n in a if a[n]!=b[n]}=={'server/modules/recorder/replay-download.js','server/test/replay-download.test.js'}
print('R2_ONLY_DURATION_BOUND_AND_REGRESSION')
PY
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 -t shn48-shn48:1.32.2-r2 . > "$REL/image-build-r2.log" 2>&1
docker run --rm --network none --memory=512m --cpus=1 --entrypoint sh shn48-shn48:1.32.2-r2 -c 'cd /app/server; DATA_DIR=/tmp/test-data RECORDINGS_DIR=/tmp/test-recordings node --test --test-concurrency=1 test/replay-download.test.js test/replay-audit.test.js' > "$REL/server-tests-r2.log" 2>&1
echo R2_TESTS_PASSED
