import hashlib, json, os, pathlib, re, subprocess

root = pathlib.Path(__file__).resolve().parents[2]
outdir = pathlib.Path(__file__).resolve().parent
env = dict(os.environ, PYTHONIOENCODING='utf-8')
result = subprocess.run(['python', str(root/'audit/2026-10-30/release-ssh.py'), 'run', str(outdir/'inspect-production.sh')], cwd=root, env=env, capture_output=True, text=True, encoding='utf-8')
if result.returncode:
    raise SystemExit(result.stderr)
(outdir/'production-readonly.txt').write_text(result.stdout, encoding='utf-8')
remote = dict((p,h) for h,p in re.findall(r'^([0-9a-f]{64})  (.+)$',result.stdout,re.M))
local = {}
for p in (root/'app/server').rglob('*'):
    if p.is_file() and not set(p.parts)&{'node_modules','__pycache__'} and p.suffix!='.pyc':
        local[p.relative_to(root/'app').as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
server_remote = {p:h for p,h in remote.items() if p.startswith('server/')}
summary = {
 'localVersion': (root/'app/VERSION').read_text().strip(),
 'remoteRuntime':result.stdout.split('--- runtime hashes ---')[0].strip(),
 'serverCounts': {'local':len(local),'remote':len(server_remote)},
 'changedServerFiles':sorted(p for p in local.keys() & server_remote.keys() if local[p]!=server_remote[p]),
 'newLocalServerFiles':sorted(local.keys()-server_remote.keys()),
 'remoteOnlyServerFiles':sorted(server_remote.keys()-local.keys()),
 'unchangedServerFileCount':sum(local[p]==server_remote[p] for p in local.keys() & server_remote.keys()),
 'localDistPresent':(root/'app/client/dist/index.html').exists(),
}
(outdir/'comparison.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
