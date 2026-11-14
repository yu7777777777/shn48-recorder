#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.12
NAME=shn48-recorder
docker exec -i $NAME sh -c 'cat > /tmp/verify-runtime.cjs' < $STAGE/verify-runtime.cjs
docker exec -i $NAME sh -c 'cat > /tmp/expected-runtime.txt' < $STAGE/pkg/app/RUNTIME-SHA256SUMS
docker exec $NAME sh -c 'wc -l /tmp/expected-runtime.txt; node /tmp/verify-runtime.cjs /tmp/expected-runtime.txt'
