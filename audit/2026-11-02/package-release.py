from pathlib import Path
import hashlib,tarfile,json
root=Path(__file__).resolve().parents[2];app=root/'app';out=root/'release/1.32.0'
out.mkdir(parents=True,exist_ok=True)
paths=[]
for directory in ['server/lib','server/modules','server/routes','server/test','server/scripts','server/assets','client/src','client/test','client/public']:
 for p in (app/directory).rglob('*'):
  if p.is_file() and not set(p.parts)&{'node_modules','__pycache__'} and p.suffix not in {'.pyc','.log'}:paths.append((p,p.relative_to(app).as_posix()))
for name in ['server/index.js','server/package.json','server/package-lock.json','client/package.json','client/package-lock.json','client/index.html','client/vite.config.js','VERSION','entrypoint.sh','CHANGELOG.md','README.md']:
 paths.append((app/name,name))
paths.append((root/'audit/2026-11-02/Dockerfile.1.32.0','Dockerfile'))
assert len(paths)>300
manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+rel+'\n' for p,rel in sorted(paths,key=lambda x:x[1]))
(out/'SOURCE-SHA256SUMS-r2').write_bytes(manifest.encode('utf8'))
archive=out/'shn48-1.32.0-source-r2.tar.gz'
assert not archive.exists()
with tarfile.open(archive,'w:gz') as t:
 for p,rel in paths:t.add(p,arcname=rel,recursive=False)
 t.add(out/'SOURCE-SHA256SUMS-r2',arcname='SOURCE-SHA256SUMS')
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(out/'ARCHIVE-SHA256SUMS-r2').write_bytes((digest+'  '+archive.name+'\n').encode('utf8'))
print(json.dumps({'files':len(paths),'bytes':archive.stat().st_size,'sha256':digest}))
