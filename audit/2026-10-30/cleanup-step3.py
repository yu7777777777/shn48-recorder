"""Safe cleanup step 3: remove orphaned official-replay fragment cache.

Every target directory under .official-replays/<liveId>/ has NO verified.mp4 and NO
complete.json, i.e. it never produced an archive. Completed archives (verified.mp4 +
complete.json) are excluded. Dry-run lists them; --apply deletes only the listed ids.
"""
import importlib.util, json, pathlib, sys
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
APPLY = '--apply' in sys.argv
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
js = r'''
const fs=require('fs'),path=require('path');
const base='/app/recordings/.official-replays';
const out={keep:[],orphans:[]};
for(const d of fs.readdirSync(base)){
  const dir=path.join(base,d); let st; try{st=fs.statSync(dir);}catch{continue;} if(!st.isDirectory())continue;
  const names=fs.readdirSync(dir);
  const verified=names.includes('verified.mp4')&&names.includes('complete.json');
  let bytes=0; for(const n of names){try{bytes+=fs.statSync(path.join(dir,n)).size;}catch{}}
  (verified?out.keep:out.orphans).push({id:d,bytes,files:names.length});
}
const b=fs.statfsSync(base);
out.keepBytes=out.keep.reduce((s,x)=>s+x.bytes,0);
out.orphanBytes=out.orphans.reduce((s,x)=>s+x.bytes,0);
out.freeGiB=+(b.bavail*b.bsize/2**30).toFixed(2);
out.orphanIds=out.orphans.map(x=>x.id);
out.keepIds=out.keep.map(x=>x.id);
delete out.orphans;delete out.keep;
console.log(JSON.stringify(out));
'''
try:
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder node', timeout=180)
    si.write(js.encode()); si.flush(); si.channel.shutdown_write()
    info = json.loads(so.read().decode().strip())
    print(json.dumps(info, ensure_ascii=False))
    if APPLY:
        ids = info['orphanIds']
        if not ids:
            print('nothing to delete')
        else:
            script = ('import os,shutil,json\n'
                      'base="/app/recordings/.official-replays"\n'
                      'ids=json.loads(' + json.dumps(json.dumps(ids)) + ')\n'
                      'removed=0\n'
                      'for d in ids:\n'
                      '    p=os.path.join(base,d)\n'
                      '    if not os.path.isdir(p): continue\n'
                      '    if os.path.exists(os.path.join(p,"verified.mp4")):\n'
                      '        raise SystemExit("refusing: verified.mp4 inside "+p)\n'
                      '    shutil.rmtree(p)\n'
                      '    removed+=1\n'
                      'print("removed",removed)\n'
                      'st=os.statvfs(base)\n'
                      'print("freeGiB", round(st.f_bavail*st.f_frsize/2**30,2))\n')
            si, so, se = c.exec_command('docker exec -i shn48-recorder python3', timeout=900)
            si.write(script.encode()); si.flush(); si.channel.shutdown_write()
            print(so.read().decode('utf8', 'replace'))
            err = se.read().decode('utf8', 'replace')
            if err: print('STDERR', err[:400])
    else:
        print('DRY RUN: no changes made')
finally:
    c.close()
