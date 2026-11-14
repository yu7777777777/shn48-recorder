#!/usr/bin/env bash
# Remove one-shot deploy helpers from the host staging dir only.
# Keeps: the release tarball, extracted package, candidate smoke scripts, README of this release.
echo "=== staging dir before ==="
ls /opt/shn48/staging/1.28.12 | head -30
rm -f /opt/shn48/staging/1.28.12/0[1-9]-*.sh
rm -f /opt/shn48/staging/1.28.12/1[0-9]-*.sh
rm -f /opt/shn48/staging/1.28.12/scan-requires.cjs
echo "=== staging dir after ==="
ls /opt/shn48/staging/1.28.12
echo "=== container still healthy ==="
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' shn48-recorder
curl -s http://127.0.0.1:3000/api/public/health
echo
rm -rf /opt/shn48/staging/1.28.12/context
echo "context removed; disk:"
df -h / | tail -1