"""Verify the 10/26 server copy without loading the whole file into memory (streaming hash)."""
import importlib.util, json, pathlib
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
js = r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const dir='/opt/shn48/recovery-preserved/1321554233301733376';
const out={dir,exists:fs.existsSync(dir),names:[]};
if(out.exists)out.names=fs.readdirSync(dir);
const p=path.join(dir,'verified.mp4'),cf=path.join(dir,'complete.json');
out.hasMp4=fs.existsSync(p);out.hasComplete=fs.existsSync(cf);
if(out.hasMp4)out.bytes=fs.statSync(p).size;
if(out.hasComplete){const c=JSON.parse(fs.readFileSync(cf,'utf8'));out.manifest={size:c.size,sha256:c.sha256,verification:c.verification,durationSeconds:c.durationSeconds,segments:c.segments,streams:c.streams};
 out.sizeMatch=c.size===out.bytes;
 out.hashVerified=new Promise((resolve)=>{const h=crypto.createHash('sha256');const s=fs.createReadStream(p);s.on('data',d=>h.update(d));s.on('end',()=>resolve(h.digest('hex')===c.sha256));s.on('error',()=>resolve(false));});}
(async()=>{if(out.hashVerified)out.hashVerified=await out.hashVerified;console.log(JSON.stringify(out,null,1));})();
'''
try:
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder node', timeout=300)
    si.write(js.encode()); si.flush(); si.channel.shutdown_write()
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:400])
finally:
    c.close()
