"""Read-only reconciliation: which archives still own files, which disk files are unowned."""
import importlib.util, pathlib, shlex
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
js = r'''
const fs=require('fs'),path=require('path');
const root=process.env.RECORDINGS_DIR||'/app/recordings';
const recs=JSON.parse(fs.readFileSync('/app/data/recordings.json','utf8'));
const byStatus={};for(const r of recs)byStatus[r.status]=(byStatus[r.status]||0)+1;
const keep=new Set();
for(const r of recs){if(['deleted','merged'].includes(r.status))continue;for(const f of [r.filePath,...(r.sourceFiles||[]),r.originalFilePath,r.clipOf].filter(Boolean)){try{keep.add(fs.realpathSync(f));}catch{keep.add(path.resolve(String(f)));}}}
const walk=(dir,out)=>{let list=[];try{list=fs.readdirSync(dir,{withFileTypes:true});}catch{return out;}for(const e of list){const p=path.join(dir,e.name);if(e.isDirectory())walk(p,out);else if(e.isFile())out.push(p);}return out;};
const files=walk(root,[]);
const orphan=[];let orphanBytes=0;
for(const f of files){const real=(()=>{try{return fs.realpathSync(f);}catch{return f;}})();if(!keep.has(real)){const s=fs.statSync(f).size;orphan.push({f:path.relative(root,f),size:s});orphanBytes+=s;}}
orphan.sort((a,b)=>b.size-a.size);
const dirs=[...new Set(orphan.map(o=>o.f.split('/').slice(0,1)[0]||o.f.split(path.sep)[0]))];
console.log(JSON.stringify({root,byStatus,activeMainFiles:keep.size,diskFiles:files.length,orphanCount:orphan.length,orphanBytes,orphanTop:orphan.slice(0,8),orphanDirs:dirs.slice(0,10),officialReplaysBytes:orphan.filter(o=>o.f.startsWith('.official-replays')).reduce((s,o)=>s+o.size,0)}));
'''
try:
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder node', timeout=180)
    si.write(js.encode()); si.flush(); si.channel.shutdown_write()
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:500])
finally:
    c.close()
