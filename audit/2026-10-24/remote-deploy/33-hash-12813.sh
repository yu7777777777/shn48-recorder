#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.13
NAME=shn48-recorder
docker exec -i $NAME sh -c 'cat > /tmp/verify-runtime.cjs' < $STAGE/verify-runtime.cjs
docker exec -i $NAME sh -c 'cat > /tmp/expected-runtime.txt' < $STAGE/pkg/app/RUNTIME-SHA256SUMS
docker exec $NAME node /tmp/verify-runtime.cjs /tmp/expected-runtime.txt
docker inspect -f 'health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}}' $NAME
curl -s -o /dev/null -w 'asset=%{http_code}\n' "http://<SERVER_IP>:3000/$(curl -s http://<SERVER_IP>:3000/ | grep -o 'assets/index-[^"]*\.js' | head -1)"
curl -s http://<SERVER_IP>:3000/ | grep -o '<title>[^<]*</title>'
docker logs --since 5m $NAME 2>&1 | grep -icE 'error|unhandled' || true
