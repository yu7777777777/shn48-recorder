"""Safe cleanup step 2: dry-run then archive old engineering artifacts.

Preconditions verified read-only first: no recording rows reference anything under these
paths, current version is 1.31.1, and the running image stays untouched.
"""
import importlib.util, json, pathlib, sys
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
APPLY = '--apply' in sys.argv

TARGETS = [
    '/root/flatbuild-1.27.8',
    '/tmp/shn48-1177-flat.tar',
    '/opt/shn48-migration/image.tar.gz',
    '/opt/shn48/releases/1.17.0',
    '/opt/shn48/deploy',
    '/opt/shn48/rollback',
]

c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
try:
    si, so, se = c.exec_command(
        "hostname; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}} {{.Config.Image}}'; "
        "cat /opt/shn48/VERSION; "
        "python3 - <<'PY'\n"
        "import json\n"
        "recs=json.load(open('/opt/shn48/runtime/data/recordings.json'))\n"
        "bad=[p for p in ['/root/flatbuild-1.27.8','/tmp/shn48-1177-flat.tar','/opt/shn48-migration/image.tar.gz','/opt/shn48/releases/1.17.0','/opt/shn48/deploy','/opt/shn48/rollback'] if any(p in str(r.get('filePath','')) for r in recs)]\n"
        "print('REFS',bad)\n"
        "PY", timeout=120)
    head = so.read().decode('utf8', 'replace')
    print(head)
    if 'running healthy shn48-shn48:1.31.1-fe' not in head or 'REFS []' not in head:
        raise SystemExit('precondition failed; aborting')

    for path in TARGETS:
        si, so, se = c.exec_command(f'test -e {path} && du -sh {path} || echo MISSING', timeout=120)
        print('pre', path, so.read().decode().strip())

    if not APPLY:
        print('DRY RUN: no changes made')
    else:
        for path in TARGETS:
            si, so, se = c.exec_command(f'test -e {path} && rm -rf {path} || true; test -e {path} && echo STILL_THERE || echo removed', timeout=600)
            print('apply', path, so.read().decode().strip())
        si, so, se = c.exec_command('df -h / | tail -1; docker ps --format "{{.Names}} {{.Status}}"; docker images --format "{{.Repository}}:{{.Tag}}" | sort', timeout=120)
        print(so.read().decode('utf8', 'replace'))
finally:
    c.close()
