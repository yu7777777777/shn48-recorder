"""Re-download the 10/26 replay on the server, then delete local D: copies at user request."""
import importlib.util, json, pathlib, sys
import paramiko
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('remote', ROOT / 'app/scripts/remote.py')
remote = importlib.util.module_from_spec(spec); spec.loader.exec_module(remote)
creds = remote.load_credentials()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'], port=int(creds.get('端口', 22)), username=creds.get('用户名', 'root'), password=creds['密码'], timeout=25)
try:
    si, so, se = c.exec_command("hostname; docker inspect shn48-recorder --format '{{.State.Status}} {{.State.Health.Status}}'", timeout=30)
    if so.read().decode().split() != ['iZbp1c7vz67w25bdjwukttZ', 'running', 'healthy']:
        raise SystemExit('host/container not healthy')
    src = (ROOT / 'audit/2026-10-30/recover-1026-server.cjs').read_text(encoding='utf8')
    si, so, se = c.exec_command('docker exec -i -w /app/server shn48-recorder nice -n 19 node', timeout=None)
    si.write(src.encode()); si.flush(); si.channel.shutdown_write()
    log = ROOT / 'audit/2026-10-30/recover-1026-server.jsonl'
    with log.open('a', encoding='utf8') as fh:
        for raw in so:
            line = raw.rstrip()
            try: event = json.loads(line)
            except ValueError: continue
            fh.write(json.dumps(event, ensure_ascii=False) + '\n'); fh.flush()
            print(json.dumps(event, ensure_ascii=False), flush=True)
    code = so.channel.recv_exit_status()
    err = se.read().decode('utf8', 'replace')
    if err: print(json.dumps({'event': 'stderr', 'text': err[-400:]}), flush=True)
    print(json.dumps({'event': 'worker_exit', 'exit': code}), flush=True)
    sys.exit(code)
finally:
    c.close()
