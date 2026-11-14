#!/usr/bin/env bash
# Post-deploy verification: health, auth guard, runtime file hashes, public reachability.
set -e
STAGE=/opt/shn48/staging/1.28.12
PKG=$STAGE/pkg/app
NAME=shn48-recorder
echo "=== 1. container state ==="
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} image={{.Config.Image}}' $NAME
docker exec $NAME cat /app/VERSION

echo "=== 2. local health + auth guard ==="
curl -s http://127.0.0.1:3000/api/public/health; echo
curl -s -o /dev/null -w "admin-config-unauth=%{http_code}\n" http://127.0.0.1:3000/api/admin/config
curl -s -o /dev/null -w "admin-health-unauth=%{http_code}\n" http://127.0.0.1:3000/api/admin/health

echo "=== 3. public reachability ==="
curl -s -o /dev/null -w "public-root=%{http_code} time=%{time_total}s\n" http://<SERVER_IP>:3000/
curl -s http://<SERVER_IP>:3000/api/public/health; echo

echo "=== 4. runtime file hashes vs RUNTIME-SHA256SUMS ==="
docker cp $PKG/RUNTIME-SHA256SUMS $NAME:/tmp/expected-runtime.txt
docker cp $STAGE/verify-runtime.cjs $NAME:/tmp/verify-runtime.cjs
docker exec $NAME node /tmp/verify-runtime.cjs /tmp/expected-runtime.txt

echo "=== 5. entrypoint / startup logs ==="
docker logs --tail 25 $NAME 2>&1
