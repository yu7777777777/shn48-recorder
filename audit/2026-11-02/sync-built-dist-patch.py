from pathlib import Path
import tarfile, shutil, hashlib
root=Path(__file__).resolve().parents[2]
dist=(root/'app/client/dist').resolve();allowed=(root/'app/client').resolve()
assert dist.parent==allowed and dist.name=='dist'
backup=root/'audit/2026-11-02/frontend-dist-before-patch.tar.gz'
assert not backup.exists()
with tarfile.open(backup,'w:gz') as t:t.add(dist,arcname='dist')
with tarfile.open(root/'release/1.32.1/frontend-dist.tar.gz','r:gz') as t:
 for item in t.getmembers():
  target=(root/'app'/item.name).resolve()
  assert target.is_relative_to(dist) or target==dist
  assert item.isfile() or item.isdir()
 shutil.rmtree(dist)
 t.extractall(root/'app',filter='data')
expected={p:h for h,p in (line.split('  ',1) for line in (root/'release/1.32.1/RUNTIME-SHA256SUMS').read_text().splitlines())}
for name,digest in expected.items():
 assert hashlib.sha256((root/'app'/name).read_bytes()).hexdigest()==digest,name
print('LOCAL_SOURCE_AND_DIST_MATCH_CANDIDATE',len(expected))
