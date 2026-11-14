echo "--- image inspection (no production container touched) ---"
docker run --rm --network none shn48-shn48:1.28.11 sh -c "pwd; echo NODE_PATH=\$NODE_PATH; ls -d /app/server/node_modules 2>/dev/null; ls /app/server/node_modules 2>/dev/null | wc -l; ls -d /app/node_modules 2>/dev/null; ls /app/node_modules 2>/dev/null | wc -l"
