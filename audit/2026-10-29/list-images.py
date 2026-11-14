"""List old release images (no deletion) with recommended keep/remove decision."""
import importlib.util, json, pathlib
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
cmd = r'''
running=$(docker inspect shn48-recorder --format '{{.Image}}')
echo "RUNNING_ID=$running"
docker inspect shn48-recorder --format 'RUNNING_IMAGE={{.Config.Image}}'
echo "== tag:imageid:size"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' | sort
echo "== containers using images"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
echo "== df"
df -h / | tail -1
'''
try:
    si, so, se = c.exec_command(cmd, timeout=120)
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:500])
finally:
    c.close()
