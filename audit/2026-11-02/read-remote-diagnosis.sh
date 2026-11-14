set -eu
echo VERSION
docker exec shn48-recorder cat /app/VERSION
echo AUDIT_JSON
docker exec shn48-recorder cat /app/data/replay_audit.json
echo CONTAINERS
docker ps -a --format '{{.Names}} {{.Status}} {{.Image}}'
echo LOGS
docker logs --since 48h shn48-recorder 2>&1 | grep -E '回放|replay|audit|修复|duration|时长' | tail -n 150 || true
