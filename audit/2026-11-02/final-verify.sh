set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.32.0
docker inspect shn48-recorder --format '{{.Config.Image}} {{.State.Health.Status}} {{.RestartCount}}'
docker exec -i shn48-recorder sh -c 'cd /app && sha256sum -c -' < "$REL/RUNTIME-SHA256SUMS" > "$REL/runtime-verify-final.log"
sha256sum -c "$REL/protected-config.before.sha256"
docker image inspect shn48-shn48:rollback-1.31.2-20261102 --format 'ROLLBACK={{.Id}}'
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-final.txt"
if test ! -s "$REL/stopped-containers-final.txt"; then echo 'No stopped containers; cleanup count=0; rollback image retained.' | tee "$REL/container-cleanup-result.txt"; fi
python3 - <<'PY'
from pathlib import Path
import yaml,subprocess,re,json
p=Path('/opt/shn48/releases/1.32.0')
a=yaml.safe_load((p/'docker-compose.yml.before').read_text());b=yaml.safe_load(Path('docker-compose.yml').read_text())
a['services']['shn48']['image']='shn48-shn48:1.32.0'
assert a==b,'Unexpected compose change'
assert (p/'docker-compose.public.yml.before').read_bytes()==Path('docker-compose.public.yml').read_bytes()
logs=subprocess.check_output(['docker','logs','shn48-recorder'],stderr=subprocess.STDOUT).decode('utf8','replace')
errors={key:len(re.findall(key,logs)) for key in ['MODULE_NOT_FOUND','uncaughtException','UnhandledPromiseRejection','TypeError']}
assert not any(errors.values()),errors
(p/'startup-error-check.json').write_text(json.dumps(errors,indent=2))
print('COMPOSE_ONLY_IMAGE_CHANGED; STARTUP_ERROR_COUNTS',json.dumps(errors))
PY
curl -fsS --max-time 15 http://127.0.0.1:3000/api/public/health
echo
df -h /
tar -czf "$REL/evidence.tar.gz" -C "$REL" baseline-image.txt candidate-image-id.txt frontend-build.log image-build-r2.log server-tests.log server-tests-r2.log client-tests.log client-tests-locale-rerun.log validation-result.json candidate-smoke.log source-verify-r2.log RUNTIME-SHA256SUMS deploy-result.json runtime-verify.log runtime-verify-final.log stopped-containers-final.txt container-cleanup-result.txt startup-error-check.json cutover-start.txt cutover-complete.txt
