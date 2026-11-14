"""Explain where Docker's image/container space actually goes (read-only)."""
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
echo "== system df"; docker system df
echo "== images full"; docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}' | sort
echo "== real layer dedupe by image"; for t in $(docker images --format '{{.Repository}}:{{.Tag}}'); do printf '%-45s ' "$t"; docker image inspect "$t" --format '{{len .RootFS.Layers}} layers'; done
echo "== unique layer bytes"; docker image inspect $(docker images -q | sort -u | tr '\n' ' ') --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null | head -20
echo "== layer dir sizes top"; du -xsh /var/lib/docker/overlay2/* 2>/dev/null | sort -h | tail -12
echo "== container writable layer"; CID=$(docker inspect shn48-recorder --format '{{.GraphDriver.Data.UpperDir}}'); echo $CID; du -xsh $CID 2>/dev/null
echo "== what fills writable layer"; du -shx $CID/* 2>/dev/null | sort -h | tail -12
echo "== inside container big dirs (excluding mounts)"; docker exec shn48-recorder sh -c 'du -shx /usr /root /opt /var /app 2>/dev/null' 
echo "== inside container /root"; docker exec shn48-recorder sh -c 'du -shx /root/* 2>/dev/null | sort -h | tail -10'
echo "== inside /app big"; docker exec shn48-recorder sh -c 'du -shx /app/* 2>/dev/null | sort -h | tail -10'
'''
try:
    si, so, se = c.exec_command(cmd, timeout=300)
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:500])
finally:
    c.close()
