set -euo pipefail
python3 - <<'PY'
import os,secrets,subprocess,time,json,pathlib
p=pathlib.Path('/opt/shn48/releases/1.32.3')
name='shn48-candidate-1.32.3'
env=dict(os.environ,ADMIN_USERNAME='release-smoke',ADMIN_PASSWORD=secrets.token_urlsafe(24),SESSION_SECRET=secrets.token_urlsafe(40))
args=['docker','run','-d','--name',name,'--network','none','--memory=512m','--cpus=0.5','-e','ADMIN_USERNAME','-e','ADMIN_PASSWORD','-e','SESSION_SECRET','-e','NODE_ENV=production','-e','DATA_DIR=/tmp/candidate-data','-e','RECORDINGS_DIR=/tmp/candidate-recordings','-e','BILIUP_DIR=/tmp/candidate-biliup','-e','CONFIG_PATH=/tmp/candidate-config.yaml','shn48-shn48:1.32.3']
subprocess.run(args,env=env,check=True,stdout=subprocess.DEVNULL)
try:
 script=r'''
 const assert=require('assert/strict');
 (async()=>{
  const base='http://127.0.0.1:3000';let ready=false;
  for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/public/health');const j=await r.json();if(j.data.version==='1.32.3'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
  assert.ok(ready,'candidate startup');
  for(const path of ['/','/daily']){const r=await fetch(base+path);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').includes('text/html'));}
  assert.equal((await fetch(base+'/api/admin/notify/settings')).status,401);
  const login=await fetch(base+'/api/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const get=async path=>{const r=await fetch(base+path,{headers:{cookie}});assert.equal(r.status,200,path);return (await r.json()).data;};
  const settings=await get('/api/admin/notify/settings');assert.equal(settings.enabled,false);assert.equal(settings.channels.telegram.botToken,undefined);assert.equal(settings.channels.telegram.botTokenSet,false);
  await get('/api/admin/notify/log');await get('/api/admin/analysis/search?q=test');await get('/api/admin/exports');await get('/api/admin/pocket48/keyword-monitor');
  const daily=await get('/api/public/daily');assert.ok(Array.isArray(daily.days));
  const rss=await fetch(base+'/api/public/daily/rss');assert.ok(rss.headers.get('content-type').includes('application/rss+xml'));assert.ok((await rss.text()).includes('<rss version="2.0">'));
  console.log(JSON.stringify({candidate:'1.32.3',entrypoint:'passed',auth:'passed',notificationsDefault:'disabled',search:'passed',exports:'passed',keywordMonitor:'passed',daily:'passed',rss:'passed'}));
 })().catch(e=>{console.error(e.message);process.exit(1)});
 '''
 result=subprocess.run(['docker','exec',name,'node','-e',script],capture_output=True,text=True,timeout=90)
 (p/'candidate-smoke.log').write_text(result.stdout+result.stderr)
 print(result.stdout,result.stderr)
 assert result.returncode==0,'Candidate smoke failed'
 state=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 assert not state['Mounts'],'Candidate must not mount production data'
 assert state['RestartCount']==0
finally:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,check=True)
PY


