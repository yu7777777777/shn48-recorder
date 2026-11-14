"""Safe cleanup step 1: delete only rebuilt, hash-verified copies of the replay recovery bundle.

Guards: the 10/26 master must exist locally with a matching SHA-256; the 10/27 partial
segments are regenerable from the official replay; nothing else is touched.
"""
import hashlib, importlib.util, json, pathlib
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
LOCAL = pathlib.Path(r'D:\shn48-recovery\staging-bundle\recovery-20261026-29')
master = LOCAL / '1321554233301733376' / 'verified.mp4'
manifest = json.loads((LOCAL / '1321554233301733376' / 'complete.json').read_text(encoding='utf-8'))
h = hashlib.sha256()
with open(master, 'rb') as fh:
    for block in iter(lambda: fh.read(1 << 20), b''):
        h.update(block)
if h.hexdigest() != manifest['sha256'] or master.stat().st_size != manifest['size']:
    raise SystemExit('local master copy missing or corrupt - refusing to delete remote bundle')

c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
try:
    si, so, se = c.exec_command("hostname; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}}'", timeout=30)
    ident = so.read().decode().split()
    if ident != ['iZbp1c7vz67w25bdjwukttZ', 'running', 'healthy']:
        raise SystemExit('container not healthy')
    cmd = (
        'set -e; '
        'test -d /opt/shn48/runtime/data/recovery-20261026-29; '
        'du -sh /opt/shn48/runtime/data/recovery-20261026-29; '
        'rm -rf /opt/shn48/runtime/data/recovery-20261026-29; '
        'test ! -e /opt/shn48/runtime/data/recovery-20261026-29; '
        'df -h / | tail -1'
    )
    si, so, se = c.exec_command(cmd, timeout=180)
    out = so.read().decode('utf8', 'replace')
    code = so.channel.recv_exit_status()
    print(out, 'exit=', code)
    if code != 0:
        raise SystemExit(se.read().decode('utf8', 'replace'))
finally:
    c.close()
log = ROOT / 'audit/2026-10-30/cleanup-step1.json'
log.write_text(json.dumps({'deleted': '/opt/shn48/runtime/data/recovery-20261026-29',
                           'reason': 'regenerable; 10/26 master kept at ' + str(master) + ' sha256=' + manifest['sha256'],
                           'localMasterSize': master.stat().st_size}, ensure_ascii=False, indent=2), encoding='utf-8')
print(log.read_text(encoding='utf-8'))
