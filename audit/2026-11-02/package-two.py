from pathlib import Path
import hashlib,tarfile,json,sys
root=Path(__file__).resolve().parents[2];app=root/'app';out=root/'release/1.32.4';out.mkdir(parents=True,exist_ok=True)
files=[]
for directory in ['client/src','client/test','client/public']:
 for p in (app/directory).rglob('*'):
  if p.is_file():files.append((p,p.relative_to(app).as_posix()))
for name in ['client/package.json','client/package-lock.json','client/index.html','client/vite.config.js','server/package.json','server/package-lock.json','server/modules/recorder/replay-download.js','server/modules/recorder/replay-audit.js','server/modules/recorder/replay-timeline-tracks.js','server/test/replay-download.test.js','server/test/replay-audit.test.js','VERSION','CHANGELOG.md']:
 files.append((app/name,name))
files.append((root/'audit/2026-11-02/Dockerfile.1.32.4','Dockerfile'))
suffix='-r3' if '--r3' in sys.argv else '-r2' if '--r2' in sys.argv else ''
archive=out/f'shn48-1.32.4-replay-patch{suffix}.tar.gz'
assert not archive.exists()
manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+name+'\n' for p,name in files)
(out/f'SOURCE-SHA256SUMS{suffix}').write_bytes(manifest.encode())
with tarfile.open(archive,'w:gz') as t:
 for p,name in files:t.add(p,arcname=name,recursive=False)
 t.add(out/f'SOURCE-SHA256SUMS{suffix}',arcname='SOURCE-SHA256SUMS')
digest=hashlib.sha256(archive.read_bytes()).hexdigest();(out/f'ARCHIVE-SHA256SUMS{suffix}').write_bytes((digest+'  '+archive.name+'\n').encode())
print(json.dumps({'files':len(files),'sha256':digest,'bytes':archive.stat().st_size}))

