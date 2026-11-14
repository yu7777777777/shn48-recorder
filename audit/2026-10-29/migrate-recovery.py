"""Move verified recovery media off the 40 GiB system disk so the disk gate clears.

Allowed: /opt/shn48/runtime/data/recovery-20261026-29 -> local D: store + SFTP re-upload.
No production recording, index, or config is touched.
"""
import hashlib, importlib.util, json, pathlib
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
HOME = pathlib.Path(r'D:\shn48-recovery')
HOME.mkdir(parents=True, exist_ok=True)
STAGE = HOME / 'staging-bundle'
STAGE.mkdir(exist_ok=True)
BACKUP_DIR = ROOT / 'audit/2026-10-29/recovery-remote-backup'

def sha256_of(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(chunk), b''):
            h.update(block)
    return h.hexdigest()

c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
log = []
try:
    si, so, se = c.exec_command("hostname; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}}'", timeout=30)
    if so.read().decode().split() != ['iZbp1c7vz67w25bdjwukttZ', 'running', 'healthy']:
        raise RuntimeError('host/container not running healthy')
    sftp = c.open_sftp()

    def read_json(remote_path):
        with sftp.open(remote_path) as f:
            return json.loads(f.read().decode('utf-8'))

    sftp.get('/opt/shn48/runtime/data/recordings.json', str(BACKUP_DIR / 'recordings.json.before-recovery'))
    live = read_json('/opt/shn48/runtime/data/auto_recording.json')
    active = [r for r in read_json('/opt/shn48/runtime/data/recordings.json') if r.get('status') == 'recording']
    if not active:
        raise RuntimeError('no active recording; re-plan instead of stopping')

    remote_hashes = {}
    listing = []
    def walk(base):
        for entry in sftp.listdir_attr(base):
            path = base + '/' + entry.filename
            listing.append((path, entry.st_size, entry.st_mode))
            if entry.st_mode & 0o040000:
                walk(path)
    walk('/opt/shn48/runtime/data/recovery-20261026-29')

    # Copy the bundle locally first (2.37 GiB verified MP4 + manifests), then re-upload.
    local = STAGE / 'recovery-20261026-29'
    total = 0
    for path, size, mode in listing:
        rel = path[len('/opt/shn48/runtime/data/recovery-20261026-29'):].lstrip('/')
        dest = local / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if mode & 0o040000:
            dest.mkdir(exist_ok=True); continue
        sftp.get(path, str(dest))
        total += size
    log.append({'step': 'downloaded-to-local', 'path': str(local), 'bytes': total})

    # Save each complete.json for the recovery ledger before removing the remote bundle.
    results = read_json('/opt/shn48/runtime/data/recovery-20261026-29/results.json')
    (BACKUP_DIR / 'recovery-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')

    verified = local / '1321554233301733376/verified.mp4'
    complete = read_json(str(local / '1321554233301733376/complete.json'))
    local_hash = sha256_of(verified)
    if local_hash != complete['sha256'] or verified.stat().st_size != complete['size']:
        raise RuntimeError('local verified.mp4 hash mismatch; nothing deleted')
    log.append({'step': 'local-verified', 'sha256': local_hash, 'size': verified.stat().st_size})

    # Re-upload to the host's persistent path (outside the container data volume).
    remote_target = '/opt/shn48/recovery-preserved'
    si, so, se = c.exec_command(f'mkdir -p {remote_target}; df -h /opt/shn48 | tail -1', timeout=60)
    log.append({'step': 'remote-target', 'info': so.read().decode().strip()})
    uploaded = 0
    for path, size, mode in listing:
        rel = path[len('/opt/shn48/runtime/data/recovery-20261026-29'):].lstrip('/')
        src = local / rel
        if mode & 0o040000:
            c.exec_command(f'mkdir -p {remote_target}/{rel}')[1].channel.recv_exit_status(); continue
        sftp.put(str(src), f'{remote_target}/{rel}')
        uploaded += size
    si, so, se = c.exec_command(f'sha256sum {remote_target}/1321554233301733376/verified.mp4', timeout=600)
    remote_hash_line = so.read().decode().strip()
    log.append({'step': 'remote-verified', 'sha256sum': remote_hash_line})
    if not remote_hash_line.startswith(local_hash):
        raise RuntimeError('remote re-upload hash mismatch; nothing deleted')

    # Align upload listing: every remote file must exist with matching size.
    si, so, se = c.exec_command(f'find {remote_target} -type f -printf "%P %s\\n" | sort', timeout=120)
    remote_files = {line.split()[0]: int(line.split()[1]) for line in so.read().decode().splitlines() if line.strip()}
    local_files = {p[len(str(local)) + 1:].replace('\\', '/'): p.stat().st_size for p in local.rglob('*') if p.is_file()}
    if remote_files != local_files:
        raise RuntimeError(f'remote listing mismatch after upload: {set(local_files.items()) ^ set(remote_files.items())}')
    log.append({'step': 'upload-complete', 'bytes': uploaded, 'files': len(remote_files)})

    # Only now delete the auxiliary bundle from the production data volume.
    si, so, se = c.exec_command('rm -rf /opt/shn48/runtime/data/recovery-20261026-29 /opt/shn48/runtime/data/recovery-staging; df -h /opt/shn48 | tail -1', timeout=120)
    log.append({'step': 'volume-released', 'info': so.read().decode().strip()})
finally:
    c.close()

(BACKUP_DIR / 'recovery-migration.json').write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(log, ensure_ascii=False, indent=2))
