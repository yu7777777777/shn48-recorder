set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
docker-compose -f docker-compose.yml -f docker-compose.public.yml config --services
python3 - <<'PY'
import yaml,json
for f in ['docker-compose.yml','docker-compose.public.yml']:
 d=yaml.safe_load(open(f));print(f,json.dumps({n:{k:v for k,v in s.items() if k in ['image','build','volumes','ports','restart','healthcheck']} for n,s in d['services'].items()}))
PY
docker ps -a --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
df -B1 /
wc -l "$REL/baseline-runtime.sha256"
