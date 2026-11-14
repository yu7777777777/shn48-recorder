STAGE=/opt/shn48/staging/1.28.12
echo "--- VERSION-like files in staged package ---"
find $STAGE/pkg/app -maxdepth 3 -name 'VERSION*' -exec sh -c 'echo "$1 => $(cat "$1" 2>/dev/null | head -1)"' _ {} \;
echo "--- server tree top level ---"
ls -la $STAGE/pkg/app/server | head -20
echo "--- candidate container view ---"
docker run --rm -v $STAGE/pkg/app/server:/app/server:ro -v $STAGE/pkg/app/VERSION:/app/VERSION:ro --entrypoint sh shn48-shn48:1.28.11 -c 'ls -la /app/server | head -20; echo root:; cat /app/VERSION'
