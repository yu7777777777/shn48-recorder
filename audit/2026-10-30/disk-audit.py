"""Read-only full disk accounting: what occupies the 40 GiB system disk."""
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
echo "== identity"; hostname; date -Is
echo "== container"; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}} {{.Config.Image}}'
echo "== df"; df -h / /var/lib/docker 2>/dev/null
echo "== docker system df"; docker system df -v 2>/dev/null | head -40
echo "== images"; docker images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}' | sort
echo "== containers all"; docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Size}}'
echo "== top level of /"; du -xhd1 / 2>/dev/null | sort -h | tail -20
echo "== /var/lib/docker breakdown"; du -xhd1 /var/lib/docker 2>/dev/null | sort -h | tail -15
echo "== overlay2 top 15"; du -xhd2 /var/lib/docker/overlay2 2>/dev/null | sort -h | tail -15
echo "== log sizes"; ls -lhS /var/lib/docker/containers/*/*.log 2>/dev/null | head -10; du -sh /var/log 2>/dev/null
echo "== shn48 runtime"; du -sh /opt/shn48/runtime/* 2>/dev/null | sort -h
echo "== data detail"; du -sh /opt/shn48/runtime/data/* 2>/dev/null | sort -h | tail -15
echo "== recordings detail"; du -xhd2 /opt/shn48/runtime/recordings 2>/dev/null | sort -h | tail -20
echo "== other /opt"; du -sh /opt/* 2>/dev/null | sort -h | tail -12
echo "== root home"; du -sh /root/* 2>/dev/null | sort -h | tail -12
'''
try:
    si, so, se = c.exec_command(cmd, timeout=300)
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:800])
finally:
    c.close()
