#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.12
PKG=$STAGE/pkg/app
NAME=shn48-candidate-12812
PORT=3199
echo "=== candidate container (isolated data, no production mounts) ==="
docker rm -f $NAME >/dev/null 2>&1 || true
rm -rf $STAGE/candidate-data $STAGE/candidate-recordings $STAGE/candidate-config
mkdir -p $STAGE/candidate-data $STAGE/candidate-recordings $STAGE/candidate-config
docker run -d --name $NAME --network none \
  -p 127.0.0.1:$PORT:3000 \
  -e COOKIE_SECURE=false -e TRUST_PROXY=false -e ENABLE_XVFB=0 \
  -v $PKG/server:/candidate/server:ro \
  -v $PKG/client/dist:/candidate/dist:ro \
  -v $PKG/VERSION:/candidate/VERSION:ro \
  -v $STAGE/candidate-data:/app/runtime/data \
  -v $STAGE/candidate-recordings:/app/runtime/recordings \
  -v $STAGE/candidate-config:/app/config \
  -w /app/server \
  --entrypoint sh shn48-shn48:1.28.11 -c '
set -e
mkdir -p /tmp/app/client
cp -a /candidate/server /tmp/app/server
cp -a /candidate/dist /tmp/app/client/dist
cp /candidate/VERSION /tmp/app/VERSION
cd /app
exec node server/index.js
' >/dev/null
echo "started $NAME"
for i in $(seq 1 40); do
  sleep 2
  status=$(docker inspect -f '{{.State.Status}}' $NAME 2>/dev/null || echo missing)
  if [ "$status" != "running" ]; then
    echo "candidate exited: $status"
    docker logs --tail 60 $NAME 2>&1
    docker rm -f $NAME >/dev/null 2>&1 || true
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$PORT/api/public/health" >/tmp/health.json 2>/dev/null; then
    echo "health: $(cat /tmp/health.json)"
    break
  fi
done
echo "--- candidate logs (tail) ---"
docker logs --tail 25 $NAME 2>&1
echo "--- candidate smoke checks (read-only) ---"
curl -s -o /dev/null -w "root %{http_code}\n" "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "admin api unauth %{http_code}\n" "http://127.0.0.1:$PORT/api/admin/config"
curl -s -o /dev/null -w "live list %{http_code}\n" "http://127.0.0.1:$PORT/api/public/live"
