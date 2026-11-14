#!/bin/bash
# Generate the release hash manifests, matching what the project's own
# scripts/manifest.mjs produces:
#   SHA256SUMS         all source/artifact hashes
#   RUNTIME-SHA256SUMS the subset the running service actually loads
#
# Computed from the staged release tree, then the runtime list is re-verified
# against the contents of the built image, since the image is what runs.
set -eu

REL=/opt/shn48/releases/1.17.6
STAGE=$REL/staged
IMG=shn48-shn48:1.17.6

echo "=== 1. build SHA256SUMS over the staged tree ==="
cd "$STAGE"
# Exclusions mirror scripts/manifest.mjs: dependencies, runtime data, secrets,
# previous manifests and release notes are not part of the hashed source set.
find . -type f \
  -not -path './client/node_modules/*' \
  -not -path './server/node_modules/*' \
  -not -path './.git/*' \
  -not -path './runtime/*' \
  -not -path './release/*' \
  -not -name '*.pyc' \
  -not -name '*.log' \
  -not -name 'SHA256SUMS' \
  -not -name 'RUNTIME-SHA256SUMS' \
  -not -name 'STAGE-SHA256SUMS' \
  -not -path './docs/releases/*' \
  | sed 's#^\./##' | sort > /tmp/filelist.txt
echo "  文件数: $(wc -l < /tmp/filelist.txt)"

while IFS= read -r f; do sha256sum "$f"; done < /tmp/filelist.txt > SHA256SUMS

# The runtime set is what the service loads at boot: server code, the built
# frontend, and VERSION.
grep -E '^(server/|client/dist/|VERSION$)' /tmp/filelist.txt > /tmp/runtimelist.txt
echo "  运行时文件数: $(wc -l < /tmp/runtimelist.txt)"
while IFS= read -r f; do sha256sum "$f"; done < /tmp/runtimelist.txt > RUNTIME-SHA256SUMS

echo
echo "=== 2. verify the runtime hashes against the image (the thing that runs) ==="
docker run --rm -v "$STAGE":/src:ro --entrypoint sh "$IMG" -c '
  cd /src
  fail=0
  while read -r want path; do
    if [ ! -f "/app/$path" ]; then
      echo "  MISSING in image: $path"; fail=1; continue
    fi
    got=$(sha256sum "/app/$path" | cut -d" " -f1)
    if [ "$got" != "$want" ]; then
      echo "  MISMATCH: $path"; echo "    manifest: $want"; echo "    image:    $got"; fail=1
    fi
  done < RUNTIME-SHA256SUMS
  n=$(wc -l < RUNTIME-SHA256SUMS)
  if [ "$fail" -eq 0 ]; then echo "  PASS all $n runtime hashes match the image"; else echo "  FAIL"; exit 1; fi
'

echo
echo "=== 3. spot-check the frontend artifact inside the image ==="
# dist lives beside the staged tree, not inside it.
docker run --rm --entrypoint sh "$IMG" -c 'sha256sum /app/client/dist/index.html /app/VERSION'
echo "--- local values (VERSION from staged, index.html from the build output) ---"
sha256sum "$STAGE/VERSION" "$REL/dist/index.html"
