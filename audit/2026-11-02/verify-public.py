from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import urllib.request,urllib.error,hashlib,json
root=Path(__file__).resolve().parents[2]
base='http://<SERVER_IP>:3000'
def get(path):
 with urllib.request.urlopen(base+path,timeout=35) as r:return r.status,r.headers.get('Content-Type',''),r.read()
health=json.loads(get('/api/public/health')[2]);assert health['data']=={'status':'ok','version':'1.32.0'}
files=[]
for line in (root/'release/1.32.0/RUNTIME-SHA256SUMS').read_text().splitlines():
 digest,name=line.split('  ',1)
 if name.startswith('client/dist/'):files.append((digest,name.removeprefix('client/dist/')))
def check(item):
 digest,name=item;status,kind,body=get('/'+name)
 assert status==200 and hashlib.sha256(body).hexdigest()==digest,name
 return name
with ThreadPoolExecutor(max_workers=4) as executor:verified=list(executor.map(check,files))
guards={}
for path in ['/api/admin/recordings','/api/admin/notify/settings','/api/admin/analysis/search?q=test','/api/admin/exports','/api/admin/pocket48/keyword-monitor']:
 try:get(path);raise AssertionError('Unauthenticated route accepted: '+path)
 except urllib.error.HTTPError as e:assert e.code==401;guards[path]=e.code
daily=json.loads(get('/api/public/daily')[2]);assert daily['success'] and isinstance(daily['data']['days'],list)
rss=get('/api/public/daily/rss');assert 'application/rss+xml' in rss[1] and b'<rss version="2.0">' in rss[2]
result={'health':health,'frontendAssetsVerified':len(verified),'unauthenticatedGuards':guards,'daily':{'published':daily['data']['published'],'days':len(daily['data']['days'])},'rss':'passed'}
(root/'audit/2026-11-02/public-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(result,ensure_ascii=False))
