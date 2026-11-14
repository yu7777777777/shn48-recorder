#!/usr/bin/env bash
# Read-only activity probe: is anything recording, merging, uploading or analysing?
set -e
NAME=shn48-recorder
echo "=== container ==="
docker inspect -f '{{.State.Status}} uptime={{.State.StartedAt}}' $NAME
echo "=== ffmpeg children ==="
docker exec $NAME sh -c 'ps -eo pid,etime,args | grep -c "[f]fmpeg"' || true
echo "=== recent log activity (last 3 min) ==="
docker logs --since 3m $NAME 2>&1 | tail -12
echo "=== queue/recording snapshot via admin API is unavailable without auth; use runtime files ==="
docker exec $NAME sh -c 'ls -la /app/runtime/data 2>/dev/null | head -5; wc -c /app/runtime/data/upload_queue.json /app/runtime/data/recordings.json 2>/dev/null' || true
