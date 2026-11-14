"""Read-only: inspect leftover replay cache of the finished 10-29 recording before any cleanup."""
import importlib.util, pathlib
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
js = r'''
const fs=require('fs'),path=require('path');
const dir='/app/recordings/.official-replays/1322642157241962496';
const names=fs.readdirSync(dir);
const recs=JSON.parse(fs.readFileSync('/app/data/recordings.json','utf8'));
const owner=recs.find(r=>String(r.liveId)==='1322642157241962496');
const otherDirs=fs.readdirSync('/app/recordings/.official-replays');
const sizes={};for(const n of names){sizes[n.split('.').pop()]=(sizes[n.split('.').pop()]||0)+1;}
console.log(JSON.stringify({dir,files:names.length,present:names.filter(n=>['verified.mp4','complete.json','plan.json','local.m3u8','replay.processing.mp4'].includes(n)),extensions:sizes,owner:owner&&{id:owner.id,status:owner.status,archiveOrigin:owner.archiveOrigin,filePath:owner.filePath,size:owner.size,createdAt:owner.createdAt,endedAt:owner.endedAt},otherReplayDirs:otherDirs.length,siblingSample:otherDirs.filter(d=>d!=='1322642157241962496').slice(0,5)}));
'''
try:
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder node', timeout=120)
    si.write(js.encode()); si.flush(); si.channel.shutdown_write()
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:400])
finally:
    c.close()
