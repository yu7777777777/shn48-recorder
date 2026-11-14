#!/usr/bin/env bash
# List stopped containers (no blanket prune). Nothing is removed by this probe.
echo "=== all containers ==="
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}'
echo "=== stopped only ==="
docker ps -a --filter status=exited --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.CreatedAt}}'
echo "=== shn48 images ==="
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}} {{.CreatedSince}}' | grep shn48 | head -20
echo "=== disk ==="
df -h / | tail -1
