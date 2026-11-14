"""Read-only detail on the biggest disk consumers before any cleanup."""
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
echo "== /tmp biggest"; du -xhd2 /tmp 2>/dev/null | sort -h | tail -12
echo "== /var breakdown"; du -xhd1 /var 2>/dev/null | sort -h | tail -8
echo "== /var/log"; du -xhd1 /var/log 2>/dev/null | sort -h | tail -10
echo "== /opt/shn48 subdirs"; du -xhd1 /opt/shn48 2>/dev/null | sort -h | tail -10
echo "== recovery-preserved"; du -sh /opt/shn48/recovery-preserved 2>/dev/null; du -xhd2 /opt/shn48/recovery-preserved 2>/dev/null | sort -h | tail -10
echo "== data/recovery-20261026-29 tree"; du -xhd2 /opt/shn48/runtime/data/recovery-20261026-29 2>/dev/null | sort -h | tail -10
echo "== recordings full tree (dirs >100M)"; du -xhd2 /opt/shn48/runtime/recordings 2>/dev/null | sort -h | tail -8
echo "== .official-replays content of today live"; ls -lh /opt/shn48/runtime/recordings/.official-replays/1322642157241962496 2>/dev/null
echo "== files >100M anywhere under /opt"; find /opt -xdev -type f -size +100M -printf '%s %p\n' 2>/dev/null | sort -n | tail -20
echo "== files >100M in /tmp /root /var/log"; find /tmp /root /var/log -xdev -type f -size +100M -printf '%s %p\n' 2>/dev/null | sort -n | tail -15
echo "== container mounts"; docker inspect shn48-recorder --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} {{.RW}}\n{{end}}'
echo "== orphan/audit test dirs"; ls -ld /opt/shn48/runtime/recordings/shn48-audit-test-* 2>/dev/null
echo "== recovery-preserved files"; find /opt/shn48/recovery-preserved -maxdepth 2 -type d 2>/dev/null
'''
try:
    si, so, se = c.exec_command(cmd, timeout=400)
    print(so.read().decode('utf8', 'replace'))
    err = se.read().decode('utf8', 'replace')
    if err: print('STDERR', err[:600])
finally:
    c.close()
