#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.12
TAR=$STAGE/shn48-1.28.12-20261024-1135.tar.gz
PKG=$STAGE/pkg
NAME=shn48-candidate-12812
PORT=3199
rm -rf $PKG
mkdir -p $PKG
tar -xzf $TAR -C $PKG
echo "staged root:"; ls $PKG/app
echo "VERSION: $(cat $PKG/app/VERSION)"
echo "--- syntax check ---"
docker run --rm --network none -v $PKG/app/server:/src:ro --entrypoint sh shn48-shn48:1.28.11 -c 'fail=0; for f in $(find /src -name "*.js"); do node --check "$f" || fail=1; done; [ $fail -eq 0 ] && echo "syntax ok"'
echo "=== candidate container (isolated data, no production mounts) ==="
docker rm -f $NAME >/dev/null 2>&1 || true
rm -rf $STAGE/candidate-data $STAGE/candidate-recordings $STAGE/candidate-config
mkdir -p $STAGE/candidate-data $STAGE/candidate-recordings $STAGE/candidate-config
docker run -d --name $NAME --network none \
  -p 127.0.0.1:$PORT:3000 \
  -e COOKIE_SECURE=false -e TRUST_PROXY=false -e ENABLE_XVFB=0 \
  -v $PKG/app/server:/candidate/server:ro \
  -v $PKG/app/client/dist:/candidate/dist:ro \
  -v $PKG/app/VERSION:/candidate/version:ro \
  -v $STAGE/candidate-data:/app/runtime/data \
  -v $STAGE/candidate-recordings:/app/runtime/recordings \
  -v $STAGE/candidate-config:/app/config \
  --entrypoint sh shn48-shn48:1.28.11 -c '
set -e
mkdir -p /tmp/app/client
cp -a /candidate/server /tmp/app/server
cp -a /candidate/dist /tmp/app/client/dist
cp /candidate/version /tmp/app/VERSION
cp /candidate/version /tmp/app/server/VERSION
cd /tmp/app
exec node server/index.js
' >/dev/null
echo "started $NAME"
ok=0
for i in $(seq 1 45); do
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
    ok=1
    break
  fi
done
[ $ok -eq 1 ] || { echo "candidate never became healthy"; docker logs --tail 60 $NAME 2>&1; exit 1; }
echo "--- candidate logs (tail) ---"
docker logs --tail 20 $NAME 2>&1
echo "--- candidate smoke (read-only) ---"
curl -s -o /dev/null -w "root %{http_code}\n" "http://127.0.0.1:$PORT/"
curl -s -o /dev/null -w "admin-api-unauth %{http_code}\n" "http://127.0.0.1:$PORT/api/admin/config"
curl -s -o /dev/null -w "public-replays-page %{http_code}\n" "http://127.0.0.1:$PORT/replays"
curl -s -o /dev/null -w "asset-index %{http_code}\n" "http://127.0.0.1:$PORT/$(grep -o 'assets/index-[^"]*\.js' $PKG/app/client/dist/index.html | head -1)"
