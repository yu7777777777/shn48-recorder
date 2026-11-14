"""Read-only host disk layout check: find space for replay recovery."""
import importlib.util,pathlib,json
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('remote',ROOT/'app/scripts/remote.py')
remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
creds=remote.load_credentials()
import paramiko
c=paramiko.SSHClient();c.load_system_host_keys();c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'],port=int(creds.get('端口',22)),username=creds.get('用户名','root'),password=creds['密码'],timeout=25)
cmd=r'''set -e
echo "== identity"; hostname
echo "== df -h"; df -h
echo "== df -i"; df -i
echo "== data/recordings usage"; du -sh /opt/shn48/runtime/data /opt/shn48/runtime/recordings /opt/shn48/runtime/biliup 2>/dev/null
echo "== recovery dirs"; du -sh /opt/shn48/runtime/data/recovery-20261026-29 /opt/shn48/runtime/data/recovery-staging 2>/dev/null || true
echo "== top data entries"; du -sh /opt/shn48/runtime/data/* 2>/dev/null | sort -h | tail -12
echo "== recordings tree"; du -sh /opt/shn48/runtime/recordings/* 2>/dev/null | sort -h | tail -12
echo "== docker df"; docker system df
echo "== running"; docker ps --format "{{.Names}} {{.Status}}"
echo "== mountpoints"; findmnt -rno TARGET,SOURCE,FSTYPE,SIZE,AVAIL | head -30
'''
try:
    si,so,se=c.exec_command(cmd,timeout=120)
    print(so.read().decode('utf8','replace'))
    err=se.read().decode('utf8','replace')
    if err:print('STDERR:',err[:1000])
finally:c.close()
