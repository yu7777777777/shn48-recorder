set -euo pipefail
cd /opt/shn48
REL=/opt/shn48/releases/1.32.4
docker inspect shn48-recorder --format '{{.Config.Image}} {{.Image}} {{.State.Health.Status}} {{.RestartCount}}'
docker exec -i shn48-recorder sh -c 'cd /app && sha256sum -c -' < "$REL/RUNTIME-SHA256SUMS" > "$REL/runtime-verify-final.log"
sha256sum -c "$REL/protected-config.before.sha256"
docker exec -i shn48-recorder node - "$(cat "$REL/originals-before.json")" < "$REL/final-two.js" | tee "$REL/repair-results-final.jsonl"
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' | tee "$REL/stopped-containers-final.txt"
if test ! -s "$REL/stopped-containers-final.txt"; then echo 'No stopped containers; cleanup count=0; rollback images retained.' | tee "$REL/container-cleanup-result.txt"; fi
docker image inspect shn48-shn48:rollback-1.32.3-20261102 --format 'ROLLBACK_1.32.3={{.Id}}'
curl -fsS --max-time 15 http://127.0.0.1:3000/api/public/health
echo
