set -euo pipefail
REL=/opt/shn48/releases/1.32.0
docker run --rm --network none --memory=768m --cpus=0.5 --shm-size=256m --entrypoint sh -v "$REL/browser-test-preload.cjs:/tmp/test-browser.cjs:ro" shn48-frontend-build:1.32.0 -c 'ln -s /app/server /build/server; node --require /tmp/test-browser.cjs --test test/public-social-ui.test.js' > "$REL/client-tests-locale-rerun.log" 2>&1
tail -n 10 "$REL/client-tests-locale-rerun.log"
