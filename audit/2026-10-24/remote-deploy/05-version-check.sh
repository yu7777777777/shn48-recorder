#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.12
PKG=$STAGE/pkg/app
echo "staged VERSION: $(cat $PKG/VERSION)"
echo "--- how version is resolved ---"
grep -rn "VERSION" /opt/shn48/staging/1.28.12/pkg/app/server/lib/version.js 2>/dev/null | head -20 || ls $PKG/server/lib | head
echo "--- candidate mount verification ---"
docker run --rm -v $PKG/VERSION:/candidate/VERSION:ro --entrypoint cat shn48-shn48:1.28.11 /candidate/VERSION
