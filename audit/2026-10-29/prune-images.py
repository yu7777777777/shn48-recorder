"""Remove only old shn48-shn48 release tags; keep running image, runtimes and rollback material."""
import importlib.util, json, pathlib
import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
KEEP = {'shn48-shn48:1.31.1-fe', 'shn48-shn48:1.31.1', 'shn48-shn48:1.31.0',
        'shn48-shn48:rollback-1.31.1', 'shn48-shn48:rollback-1.31.0',
        'shn48-asr-runtime:1.2.1', 'shn48-backup115-runtime:1.0.0',
        'public.ecr.aws/docker/library/python:3.12.11-slim-bookworm'}
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
log = {'removed': [], 'kept': [], 'errors': []}
try:
    si, so, se = c.exec_command("hostname; docker inspect shn48-recorder --format '{{.State.Status}} {{.Config.Image}}'", timeout=30)
    if so.read().decode().split() != ['iZbp1c7vz67w25bdjwukttZ', 'running', 'shn48-shn48:1.31.1-fe']:
        raise RuntimeError('unexpected host or running image')
    si, so, se = c.exec_command("docker images --format '{{.Repository}}:{{.Tag}}'", timeout=60)
    tags = [t.strip() for t in so.read().decode().splitlines() if t.strip()]
    for tag in tags:
        if tag in KEEP:
            log['kept'].append(tag); continue
        si, so, se = c.exec_command(f'docker rmi {tag}', timeout=180)
        out = (so.read() + se.read()).decode('utf8', 'replace').strip().splitlines()
        code = so.channel.recv_exit_status()
        (log['removed'] if code == 0 else log['errors']).append({'tag': tag, 'code': code, 'note': out[-1][:140] if out else ''})
    si, so, se = c.exec_command("docker system df; df -h / | tail -1; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}}'; docker images --format '{{.Repository}}:{{.Tag}}' | sort", timeout=120)
    log['after'] = so.read().decode('utf8', 'replace')
finally:
    c.close()
out = ROOT / 'audit/2026-10-29/recovery-remote-backup/image-cleanup.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: (v if k != 'removed' else [r['tag'] for r in v]) for k, v in log.items()}, ensure_ascii=False, indent=2))
