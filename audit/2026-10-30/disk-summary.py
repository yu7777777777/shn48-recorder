"""Compact read-only disk report: summary only, no per-file listing."""
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
echo "DF"; df -h / | tail -1
echo "TMP"; du -xsh /tmp 2>/dev/null; ls -lhS /tmp | head -8
echo "VARDIR"; du -xsh /var/log /var/lib/docker 2>/dev/null
echo "OPT_TOP"; du -xsh /opt/* 2>/dev/null | sort -h | tail -14
echo "OPT_SHN48"; du -xsh /opt/shn48/* 2>/dev/null | sort -h
echo "DATA_TOP"; du -xsh /opt/shn48/runtime/data/* 2>/dev/null | sort -h | tail -8
echo "REC_TOP"; du -xsh /opt/shn48/runtime/recordings/* /opt/shn48/runtime/recordings/.[a-z]* 2>/dev/null | sort -h | tail -8
echo "RECOVERY_TREE"; find /opt/shn48/runtime/data/recovery-20261026-29 -maxdepth 2 -type d 2>/dev/null; du -xsh /opt/shn48/runtime/data/recovery-20261026-29/* 2>/dev/null
echo "RELEASES"; ls -1 /opt/shn48/releases 2>/dev/null | tail -20; du -xsh /opt/shn48/releases/* 2>/dev/null | sort -h | tail -10
echo "SHN48_RELEASES"; ls -1 /opt/shn48-releases 2>/dev/null | tail -15
echo "BACKUPS"; ls -1 /opt/backups /opt/shn48-backups /opt/releases 2>/dev/null | head -40
echo "ROOT"; du -xsh /root/* 2>/dev/null | sort -h | tail -6
echo "MIGRATION"; ls -1 /opt/shn48-migration 2>/dev/null | head
echo "ACTIVE_REC"; grep -o '"status":"recording"' /opt/shn48/runtime/data/recordings.json 2>/dev/null | wc -l
'''
try:
    si, so, se = c.exec_command(cmd, timeout=400)
    print(so.read().decode('utf8', 'replace'))
finally:
    c.close()
