set -euo pipefail
REL=/opt/shn48/releases/1.32.1
cd "$REL"
sha256sum -c ARCHIVE-SHA256SUMS
mkdir stage
tar -xzf shn48-1.32.1-frontend-patch.tar.gz -C stage
cd stage
sha256sum -c SOURCE-SHA256SUMS > "$REL/source-verify.log"
cat > "$REL/build-worker.sh" <<'BUILD'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.1
trap 'rc=$?; echo "$rc" > "$REL/build.exit"' EXIT
cd "$REL/stage"
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 --target frontend -t shn48-frontend-build:1.32.1 . > "$REL/frontend-build.log" 2>&1
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 -t shn48-shn48:1.32.1 . > "$REL/image-build.log" 2>&1
docker run --rm --network none --memory=768m --cpus=1 --shm-size=256m --entrypoint node -v "$REL/patch-layout-check.cjs:/tmp/layout-check.cjs:ro" shn48-frontend-build:1.32.1 /tmp/layout-check.cjs > "$REL/layout-tests.log" 2>&1
docker image inspect shn48-shn48:1.32.1 --format '{{.Id}}' > "$REL/candidate-image-id.txt"
docker run --rm --network none --entrypoint sh shn48-shn48:1.32.1 -c 'cd /app; find server client/dist -type f ! -path "*/node_modules/*" -exec sha256sum {} +; sha256sum VERSION' | sort -k2 > "$REL/RUNTIME-SHA256SUMS"
python3 - <<'PY'
from pathlib import Path
def load(p):return {name:digest for digest,name in (line.split('  ',1) for line in p.read_text().splitlines())}
root=Path('/opt/shn48/releases');a=load(root/'1.32.0/RUNTIME-SHA256SUMS');b=load(root/'1.32.1/RUNTIME-SHA256SUMS')
source=load(root/'1.32.1/stage/SOURCE-SHA256SUMS')
for name,digest in a.items():
 if name.startswith('server/') and name not in ['server/package.json','server/package-lock.json']:assert b[name]==digest,name
for name in ['server/package.json','server/package-lock.json','VERSION']:assert source[name]==b[name],name
print('PATCH_BACKEND_BUSINESS_HASHES_UNCHANGED')
PY
cid=$(docker create shn48-shn48:1.32.1)
trap 'docker rm "$cid" >/dev/null' RETURN
mkdir -p "$REL/extracted/client"
docker cp "$cid:/app/client/dist" "$REL/extracted/client/"
docker rm "$cid" >/dev/null
tar -czf "$REL/frontend-dist.tar.gz" -C "$REL/extracted" client/dist
BUILD
chmod 700 "$REL/build-worker.sh"
nohup bash "$REL/build-worker.sh" > "$REL/build-worker.log" 2>&1 < /dev/null &
echo "PATCH_BUILD_PID=$!"
