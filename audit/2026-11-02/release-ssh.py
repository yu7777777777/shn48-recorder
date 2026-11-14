import importlib.util, pathlib, sys
import paramiko
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('remote',ROOT/'app/scripts/remote.py')
remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
creds=remote.load_credentials()
assert creds['ip']=='<SERVER_IP>'
c=paramiko.SSHClient();c.load_system_host_keys();c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(creds['ip'],port=int(creds.get('端口',22)),username=creds.get('用户名','root'),password=creds['密码'],timeout=25)
try:
 mode=sys.argv[1]
 if mode=='run':
  cmd=pathlib.Path(sys.argv[2]).read_text(encoding='utf8')
  _,out,err=c.exec_command('bash -se',timeout=1200)
  out.channel.sendall(cmd.encode());out.channel.shutdown_write()
  for line in out: print(line.rstrip('\n'),flush=True)
  e=err.read().decode('utf8','replace');print(e,file=sys.stderr) if e else None
  sys.exit(out.channel.recv_exit_status())
 elif mode=='put':
  target=sys.argv[3];assert target.startswith(('/opt/shn48/releases/1.32.0/','/opt/shn48/releases/1.32.1/','/opt/shn48/releases/1.32.2/','/opt/shn48/releases/1.32.3/','/opt/shn48/releases/1.32.4/')) and '..' not in target
  with c.open_sftp() as s:s.put(sys.argv[2],target)
  print('UPLOADED',target)
 elif mode=='get':
  source=sys.argv[2];assert source.startswith(('/opt/shn48/releases/1.32.0/','/opt/shn48/releases/1.32.1/','/opt/shn48/releases/1.32.2/','/opt/shn48/releases/1.32.3/','/opt/shn48/releases/1.32.4/')) and '..' not in source
  with c.open_sftp() as s:s.get(source,sys.argv[3])
  print('DOWNLOADED',source)
finally:c.close()

