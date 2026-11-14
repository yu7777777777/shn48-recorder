#!/usr/bin/env bash
set -e
echo "=== mounts of production container ==="
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Type}}){{"\n"}}{{end}}' shn48-recorder
echo "=== env that points at data ==="
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' shn48-recorder | grep -E 'DATA_DIR|RECORDINGS|CONFIG_DIR|COOKIE|TRUST' || true
