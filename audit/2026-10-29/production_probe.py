"""Read-only production probes; never output credentials or authenticated bodies."""
import importlib.util, json, os, sys, pathlib, shlex
import paramiko
ROOT=pathlib.Path(__file__).resolve().parents[2]
os.chdir(ROOT)
spec=importlib.util.spec_from_file_location('remote', ROOT/'app/scripts/remote.py')
remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
creds=remote.load_credentials()
c=paramiko.SSHClient(); c.load_system_host_keys(); c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'],port=int(creds.get('端口',22)),username=creds.get('用户名','root'),password=creds['密码'],timeout=25)
results=[]
def run(name,cmd,stdin_text=None):
    si,so,se=c.exec_command(cmd,timeout=90)
    if stdin_text is not None:
        si.write(stdin_text.encode('utf-8'));si.flush();si.channel.shutdown_write()
    out=so.read().decode('utf-8','replace');err=se.read().decode('utf-8','replace');code=so.channel.recv_exit_status()
    row={'name':name,'exit':code,'stdout':out,'stderr':err};results.append(row)
    shown={**row,'stdout':out[:12000]+'\n[truncated; full output saved]' if len(out)>12000 else out}
    print(json.dumps(shown,ensure_ascii=False),flush=True)
try:
    if len(sys.argv)>1:
        src=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig')
        run('node_probe','docker exec -i -w /app/server shn48-recorder node',src)
    else:
        for name,cmd in [
          ('identity','hostname; date -Is'),
          ('container','docker inspect shn48-recorder --format '+shlex.quote('{{.Config.Image}} {{.Config.WorkingDir}} {{.State.Status}} {{.State.Health.Status}} {{.State.StartedAt}} restarts={{.RestartCount}}')),
          ('mounts','docker inspect shn48-recorder --format '+shlex.quote('{{range .Mounts}}{{.Source}} -> {{.Destination}}\n{{end}}')),
          ('version','docker exec shn48-recorder cat /app/VERSION'),
          ('capacity','df -h /opt/shn48/runtime/recordings; free -m; docker stats --no-stream shn48-recorder'),
          ('processes','docker top shn48-recorder -eo pid,ppid,comm'),
          ('recent_logs','docker logs --since 2026-10-29T09:35:59Z --timestamps shn48-recorder 2>&1 | tail -70'),
          ('stopped_containers','docker ps -a --filter status=exited --format '+shlex.quote('{{.Names}} {{.Image}} {{.Status}}')),
        ]:run(name,cmd)
finally:
    c.close()
    dest=ROOT/'audit/2026-10-29'/((pathlib.Path(sys.argv[1]).stem+'-results.json') if len(sys.argv)>1 else 'production-baseline.json')
    dest.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
if any(r['exit'] for r in results):sys.exit(1)
