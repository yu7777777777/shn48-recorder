"""Run the read-only-to-index recovery worker over verified SSH; stream redacted events."""
import importlib.util,json,pathlib,sys,os,time
import paramiko
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('remote',ROOT/'app/scripts/remote.py')
remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
creds=remote.load_credentials()
c=paramiko.SSHClient();c.load_system_host_keys();c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'],port=int(creds.get('端口',22)),username=creds.get('用户名','root'),password=creds['密码'],timeout=25)
log=ROOT/'audit/2026-10-29/recovery-events.jsonl'
try:
    si,so,se=c.exec_command('hostname; docker inspect shn48-recorder --format "{{.State.Status}} {{.State.Health.Status}}"',timeout=30)
    identity=so.read().decode('utf8','replace').strip()
    if identity.splitlines()!=['iZbp1c7vz67w25bdjwukttZ','running healthy']:
        raise RuntimeError('Unexpected host or unhealthy container')
    print(json.dumps({'event':'identity_verified','host':'iZbp1c7vz67w25bdjwukttZ'}),flush=True)
    source=(ROOT/'audit/2026-10-29/recover-media.cjs').read_text(encoding='utf8')
    si,so,se=c.exec_command('docker exec -i -w /app/server shn48-recorder nice -n 15 node',timeout=None)
    si.write(source.encode('utf8'));si.flush();si.channel.shutdown_write()
    with log.open('a',encoding='utf8') as output:
        for raw in so:
            # Worker emits only selected metadata and no upstream/signed URLs.
            line=raw.rstrip('\r\n')
            try:event=json.loads(line)
            except ValueError:continue
            output.write(json.dumps(event,ensure_ascii=False)+'\n');output.flush()
            print(json.dumps(event,ensure_ascii=False),flush=True)
    code=so.channel.recv_exit_status()
    errors=se.read().decode('utf8','replace')
    if errors:print(json.dumps({'event':'stderr','present':True,'length':len(errors)}),flush=True)
    print(json.dumps({'event':'worker_exit','exit':code}),flush=True)
    sys.exit(code)
finally:c.close()
