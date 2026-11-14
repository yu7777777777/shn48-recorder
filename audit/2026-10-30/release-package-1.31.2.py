from pathlib import Path
import hashlib,tarfile,json
root=Path(__file__).resolve().parents[2]
app=root/'app';out=root/'release/1.31.2';out.mkdir(parents=True,exist_ok=True)
assert (app/'VERSION').read_text().strip()=='1.31.2'
files=[(p,p.relative_to(app).as_posix()) for p in sorted((app/'client/dist').rglob('*')) if p.is_file()]
assert 30<len(files)<100 and not any('node_modules' in rel for _,rel in files)
files += [(app/'VERSION','VERSION'),(root/'audit/2026-10-30/deploy-1.31.2.Dockerfile','Dockerfile.overlay')]
manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+rel+'\n' for p,rel in files)
(out/'OVERLAY-SHA256SUMS').write_text(manifest,encoding='utf8')
archive=out/'shn48-1.31.2-frontend-overlay.tar.gz'
assert not archive.exists(),'Never replace an existing release archive'
with tarfile.open(archive,'w:gz') as t:
 for p,rel in files:t.add(p,arcname=rel,recursive=False)
 t.add(out/'OVERLAY-SHA256SUMS',arcname='OVERLAY-SHA256SUMS')
(out/'ARCHIVE-SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
print(json.dumps({'artifact':str(archive),'distFiles':len(files)-2,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'bytes':archive.stat().st_size}))
