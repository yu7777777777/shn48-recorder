set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.31.2
docker inspect shn48-recorder --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}'
docker exec -i shn48-recorder sh -c 'cd /app && sha256sum -c -' < "$REL/RUNTIME-SHA256SUMS" > "$REL/runtime-verify-final.log"
wc -l "$REL/runtime-verify-final.log"
curl -fsS http://127.0.0.1:3000/api/public/health; echo
printf 'UNAUTH_STATUS=';curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/admin/recordings;echo
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-final.txt"
if [ ! -s "$REL/stopped-containers-final.txt" ]; then echo 'No stopped containers; cleanup count=0; rollback images retained.' | tee "$REL/container-cleanup-result.txt"; fi
docker image inspect shn48-shn48:rollback-1.31.1-20261030 --format 'ROLLBACK={{.Id}}'
sha256sum -c "$REL/protected-config.before.sha256"
python3 - <<'PY'
from pathlib import Path
import yaml,json
p=Path('/opt/shn48/releases/1.31.2')
a=yaml.safe_load((p/'docker-compose.yml.before').read_text());b=yaml.safe_load(Path('docker-compose.yml').read_text())
a['services']['shn48']['image']='shn48-shn48:1.31.2'
assert a==b,'Unexpected compose change'
assert (p/'docker-compose.public.yml.before').read_bytes()==Path('docker-compose.public.yml').read_bytes()
print('COMPOSE_ONLY_IMAGE_CHANGED')
PY
df -h /
