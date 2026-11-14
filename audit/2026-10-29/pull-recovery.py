"""Pull the recovery bundle locally for safekeeping (read-only on the server)."""
import hashlib, importlib.util, json, pathlib, time
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
HOME = pathlib.Path(r'D:\shn48-recovery')
LOCAL = HOME / 'staging-bundle' / 'recovery-20261026-29'
LOCAL.mkdir(parents=True, exist_ok=True)

c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
try:
    si, so, se = c.exec_command("find /opt/shn48/runtime/data/recovery-20261026-29 -type f -printf '%P %s\\n' | sort", timeout=120)
    files = {}
    for line in so.read().decode().splitlines():
        if not line.strip():
            continue
        rel, size = line.rsplit(' ', 1)
        files[rel] = int(size)
    sftp = c.open_sftp()
    got = 0
    for rel, size in sorted(files.items()):
        dest = LOCAL / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.stat().st_size == size:
            got += 1
            continue
        t0 = time.time()
        sftp.get(f'/opt/shn48/runtime/data/recovery-20261026-29/{rel}', str(dest))
        got += 1
        if time.time() - t0 > 5:
            print(json.dumps({'slow': rel, 'size': size, 'seconds': round(time.time() - t0)}), flush=True)
    sftp.close()
    missing = [(r, s) for r, s in files.items() if not (LOCAL / r).exists() or (LOCAL / r).stat().st_size != s]
    print(json.dumps({'remoteFiles': len(files), 'localMatched': got, 'missing': missing[:5]}, ensure_ascii=False))
finally:
    c.close()
