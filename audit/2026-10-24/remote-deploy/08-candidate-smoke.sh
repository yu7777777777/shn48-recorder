#!/usr/bin/env bash
NAME=shn48-candidate-12812
docker cp "$(dirname "$0")/candidate-smoke.cjs" $NAME:/tmp/smoke.cjs 2>/dev/null || \
  docker exec -i $NAME sh -c 'cat > /tmp/smoke.cjs' < "$(dirname "$0")/candidate-smoke.cjs"
docker exec $NAME node /tmp/smoke.cjs
