#!/usr/bin/env bash
set -e
NAME=shn48-recorder
echo "=== health after warm-up ==="
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' $NAME
echo "=== public endpoints ==="
for p in / /replays /admin /api/public/health /api/public/live; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://<SERVER_IP>:3000$p" || echo err)
  echo "$p -> $code"
done
echo "=== public live body (F14 contract) ==="
curl -s http://<SERVER_IP>:3000/api/public/live | head -c 200; echo
echo "=== served frontend asset from new build ==="
asset=$(curl -s http://<SERVER_IP>:3000/ | grep -o 'assets/index-[^"]*\.js' | head -1)
echo "asset=$asset"
curl -s -o /dev/null -w "asset=%{http_code}\n" "http://<SERVER_IP>:3000/$asset"
echo "title: $(curl -s http://<SERVER_IP>:3000/ | grep -o '<title>[^<]*</title>')"
echo "=== startup logs ==="
docker logs --tail 15 $NAME 2>&1
echo "=== image compare ==="
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' | grep shn48-shn48 | head -3
