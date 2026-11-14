"""Post-cleanup verification: service healthy, archive intact, official media still reachable."""
import importlib.util, pathlib
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
js = r'''
const fs=require('fs');
const recs=JSON.parse(fs.readFileSync('/app/data/recordings.json','utf8'));
const live=recs.filter(r=>r.status!=='deleted'&&r.status!=='merged');
const st=fs.statfsSync('/app/recordings');
const out={statuses:{},archives:live.map(r=>({id:r.id,liveId:r.liveId,status:r.status,size:r.size,filePath:r.filePath,onDisk:!!r.filePath&&fs.existsSync(r.filePath),diskBytes:r.filePath&&fs.existsSync(r.filePath)?fs.statSync(r.filePath).size:null})),freeGiB:+(st.bavail*st.bsize/2**30).toFixed(2),officialReplayDirs:(()=>{try{return fs.readdirSync('/app/recordings/.official-replays').length;}catch{return 0;}})()};
for(const r of recs)out.statuses[r.status]=(out.statuses[r.status]||0)+1;
(async()=>{
 const replay=require('./modules/pocket48/replay');
 const probe=async(id)=>{try{const d=await replay.getReplay(id);return{liveId:id,ok:true,hasStream:!!d.streamUrl,durationSeconds:d.replay?.durationSeconds};}catch(e){return{liveId:id,ok:false,error:e.code||e.name};}};
 out.officialProbe=[await probe('1321966661005021184'),await probe('1322332610476445696'),await probe('1321554233301733376')];
 const liveSvc=await fetch('http://127.0.0.1:3000/api/public/health',{signal:AbortSignal.timeout(10000)}).then(r=>r.json()).catch(e=>({error:e.name}));
 out.health=liveSvc;
 console.log(JSON.stringify(out));
})();
'''
try:
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder node', timeout=200)
    si.write(js.encode()); si.flush(); si.channel.shutdown_write()
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:400])
finally:
    c.close()
