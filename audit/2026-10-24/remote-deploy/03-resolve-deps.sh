set -e
STAGE=/opt/shn48/staging/1.28.12
docker run --rm --network none -w /app/server shn48-shn48:1.28.11 sh -c '
set -e
export NODE_PATH=/app/server/node_modules
miss=0
for m in express js-yaml playwright qrcode; do
  node -e "require.resolve(process.argv[1])" "$m" >/dev/null 2>&1 && echo "ok   $m" || { echo "MISSING $m"; miss=1; }
done
echo "node_modules packages: $(ls /app/server/node_modules | wc -l)"
[ $miss -eq 0 ] && echo "all dependencies resolvable"
'
