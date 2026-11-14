set -euo pipefail
BASE=/opt/shn48
REL=$BASE/releases/1.32.0
test "$(readlink -f "$BASE")" = /opt/shn48
test ! -e "$REL"
test "$(docker inspect shn48-recorder -f '{{.Image}}')" = sha256:38207a421da23e8fbc4ed8ca571dd83362f187848ad7c73a4e55dbef698208b8
mkdir -p "$REL"
cp -p "$BASE/docker-compose.yml" "$REL/docker-compose.yml.before"
cp -p "$BASE/docker-compose.public.yml" "$REL/docker-compose.public.yml.before"
cp -p "$BASE/VERSION" "$REL/VERSION.before"
docker inspect -f '{{.Config.Image}} {{.Image}} {{.State.Health.Status}}' shn48-recorder | tee "$REL/baseline-image.txt"
docker exec shn48-recorder sh -c 'node --version; npm --version; command -v chromium || true; command -v ffmpeg; command -v ffprobe; du -sh /app/server/node_modules; test -x /opt/asr-venv/bin/python; test -x /opt/backup115/bin/python'
docker exec shn48-recorder node - <<'JS'
JS
df -h /
docker ps -a --filter status=exited --filter status=created --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
docker tag shn48-shn48:1.31.2 shn48-shn48:rollback-1.31.2-20261102
