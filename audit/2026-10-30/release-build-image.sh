set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
EXPECTED_BASE=sha256:c48c3c5b5497505ca3534d89f41460609a69bc47acb92db35ad747418704adfa
test "$(docker inspect shn48-recorder --format '{{.Image}}')" = "$EXPECTED_BASE"
cd "$REL"
python3 -c "from pathlib import Path;p=Path('ARCHIVE-SHA256SUMS');p.write_bytes(p.read_bytes().replace(bytes([13,10]),bytes([10])))"
sha256sum -c ARCHIVE-SHA256SUMS
test ! -e stage
mkdir stage
python3 - <<'PY'
import tarfile
with tarfile.open('shn48-1.31.2-frontend-overlay.tar.gz') as t:
 for x in t.getmembers():
  assert x.isfile() and not x.name.startswith('/') and '..' not in x.name.split('/')
  assert x.name.startswith('client/dist/') or x.name in ['VERSION','Dockerfile.overlay','OVERLAY-SHA256SUMS']
 t.extractall('stage')
PY
cd stage
python3 -c "from pathlib import Path;p=Path('OVERLAY-SHA256SUMS');p.write_bytes(p.read_bytes().replace(bytes([13,10]),bytes([10])))"
sha256sum -c OVERLAY-SHA256SUMS > "$REL/upload-verify.log"
test "$(cat VERSION)" = 1.31.2
docker tag "$EXPECTED_BASE" shn48-shn48:rollback-1.31.1-20261030
docker build -f Dockerfile.overlay -t shn48-shn48:1.31.2 . > "$REL/build.log" 2>&1
docker run --rm --network none -v "$REL/stage:/release:ro" --entrypoint sh shn48-shn48:1.31.2 -c 'cd /app && grep -E "  (client/dist/|VERSION$)" /release/OVERLAY-SHA256SUMS | sha256sum -c -' > "$REL/candidate-overlay-verify.log"
docker run --rm --network none --entrypoint sh shn48-shn48:1.31.2 -c 'cd /app && find server client/dist -type f ! -path "*/node_modules/*" ! -path "*/.cache/*" ! -name "*.log" -exec sha256sum {} \; ; sha256sum VERSION' > "$REL/RUNTIME-SHA256SUMS"
python3 - <<'PY'
from pathlib import Path
import subprocess,json
p=Path('/opt/shn48/releases/1.31.2')
def load(n):return {x.split('  ',1)[1]:x.split('  ',1)[0] for x in (p/n).read_text().splitlines() if '  server/' in x}
a=load('baseline-runtime.sha256');b=load('RUNTIME-SHA256SUMS')
allowed=['server/package.json','server/package-lock.json']
diff=[k for k,v in a.items() if b.get(k)!=v and k not in allowed]
assert not diff and not [k for k in b if k not in a],diff
code='const fs=require("fs");console.log(JSON.stringify(["server/package.json","server/package-lock.json"].map(p=>JSON.parse(fs.readFileSync("/app/"+p,"utf8")))))'
def pkg(image):return json.loads(subprocess.check_output(['docker','run','--rm','--network','none','--entrypoint','node',image,'-e',code]))
before=pkg('shn48-shn48:rollback-1.31.1-20261030');after=pkg('shn48-shn48:1.31.2')
for old,new in zip(before,after):
 oldver=old['version'];old['version']='1.31.2'
 if 'packages' in old and '' in old['packages']:old['packages']['']['version']='1.31.2'
 if old.get('description'):old['description']=old['description'].replace(oldver,'1.31.2')
 assert old==new,'Unexpected server metadata/dependency change'
print(json.dumps({'backendUnchanged':len(a)-len(allowed),'metadataVersionOnly':len(allowed),'runtimeFiles':len((p/'RUNTIME-SHA256SUMS').read_text().splitlines())}))
PY
docker image inspect shn48-shn48:1.31.2 --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}'
echo CANDIDATE_VERIFIED
