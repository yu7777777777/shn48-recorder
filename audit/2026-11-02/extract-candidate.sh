set -euo pipefail
REL=/opt/shn48/releases/1.32.0
cd "$REL"
docker image inspect shn48-shn48:1.32.0 --format '{{.Id}}' > candidate-image-id.txt
docker run --rm --network none --entrypoint sh shn48-shn48:1.32.0 -c 'cd /app; find server client/dist -type f ! -path "*/node_modules/*" -exec sha256sum {} +; sha256sum VERSION' | sort -k2 > RUNTIME-SHA256SUMS
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/shn48/releases/1.32.0')
def manifest(file):
 return {name:digest for digest,name in (line.split('  ',1) for line in file.read_text().splitlines())}
source=manifest(p/'stage-r2/SOURCE-SHA256SUMS');runtime=manifest(p/'RUNTIME-SHA256SUMS')
expected={name:digest for name,digest in source.items() if name.startswith('server/') or name=='VERSION'}
actual={name:digest for name,digest in runtime.items() if name.startswith('server/') or name=='VERSION'}
assert expected==actual,'Candidate server source differs from release archive'
print('CANDIDATE_SERVER_SOURCE_VERIFIED',len(expected))
PY
mkdir -p extracted/client
cid=$(docker create shn48-shn48:1.32.0)
trap 'docker rm "$cid" >/dev/null' EXIT
docker cp "$cid:/app/client/dist" extracted/client/
tar -czf frontend-dist.tar.gz -C extracted client/dist
sha256sum frontend-dist.tar.gz
