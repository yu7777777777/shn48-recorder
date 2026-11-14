"""Diagnose why Node and Python disagree about .official-replays contents (read-only)."""
import importlib.util, pathlib
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
cmd = r'''
set +e
echo "== image arch vs container"; docker inspect shn48-recorder --format '{{.Config.Image}} {{.Platform}}'; docker exec shn48-recorder sh -c 'uname -m; which python3 node; python3 -V; node -v'
echo "== host dir"; ls -la /opt/shn48/runtime/recordings/.official-replays/1309632252058865664 | head -20
echo "== container ls"; docker exec shn48-recorder ls -la /app/recordings/.official-replays/1309632252058865664 | head -20
echo "== host file count"; ls /opt/shn48/runtime/recordings/.official-replays/1309632252058865664 | wc -l
echo "== container python vision"; docker exec shn48-recorder python3 -c "import os;d='/app/recordings/.official-replays/1309632252058865664';n=os.listdir(d);print(len(n),[x for x in n if x in ('verified.mp4','complete.json','plan.json')])"
echo "== container node vision"; docker exec shn48-recorder node -e "const fs=require('fs');const d='/app/recordings/.official-replays/1309632252058865664';const n=fs.readdirSync(d);console.log(n.length,n.filter(x=>['verified.mp4','complete.json','plan.json'].includes(x)))"
echo "== grep records for liveId"; docker exec shn48-recorder sh -c 'grep -o "1309632252058865664[^,]*" /app/data/recordings.json | head -3'
'''
try:
    si, so, se = c.exec_command(cmd, timeout=200)
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:600])
finally:
    c.close()
