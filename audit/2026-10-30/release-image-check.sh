set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
BASE=$(docker inspect shn48-recorder --format '{{.Image}}')
docker run --rm --network none --entrypoint sh "$BASE" -c 'cd /app && find server -type f ! -path "*/node_modules/*" ! -path "*/.cache/*" ! -name "*.log" -exec sha256sum {} \;' > "$REL/image-server.sha256"
python3 - <<'PY'
from pathlib import Path
p=Path('/opt/shn48/releases/1.31.2')
def load(n):
 return {x.split('  ',1)[1]:x.split('  ',1)[0] for x in (p/n).read_text().splitlines() if '  server/' in x}
a=load('baseline-runtime.sha256');b=load('image-server.sha256')
d=[k for k,v in a.items() if b.get(k)!=v]
print('RUNNING_VS_IMAGE_SERVER',{'running':len(a),'image':len(b),'differences':d,'imageOnly':[k for k in b if k not in a]})
if d or any(k not in a for k in b):raise SystemExit(7)
PY
