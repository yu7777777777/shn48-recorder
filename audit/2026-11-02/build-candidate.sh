set -euo pipefail
REL=/opt/shn48/releases/1.32.0
cd "$REL"
tr -d '\r' < ARCHIVE-SHA256SUMS | sha256sum -c -
test ! -e stage
mkdir stage
tar -xzf shn48-1.32.0-source.tar.gz -C stage
cd stage
tr -d '\r' < SOURCE-SHA256SUMS | sha256sum -c - > "$REL/source-verify.log"
cat > "$REL/build-worker.sh" <<'BUILD'
#!/bin/bash
set -euo pipefail
REL=/opt/shn48/releases/1.32.0
trap 'rc=$?; echo "$rc" > "$REL/build.exit"' EXIT
cd "$REL/stage"
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 --target frontend -t shn48-frontend-build:1.32.0 . > "$REL/frontend-build.log" 2>&1
docker build --memory=1024m --cpu-period=100000 --cpu-quota=100000 -t shn48-shn48:1.32.0 . > "$REL/image-build.log" 2>&1
docker run --rm --network none --memory=1024m --cpus=1 --entrypoint sh -e DATA_DIR=/tmp/test-data -e RECORDINGS_DIR=/tmp/test-recordings shn48-shn48:1.32.0 -c 'mkdir -p "$DATA_DIR" "$RECORDINGS_DIR"; node --test --test-concurrency=1 test/*.test.js' > "$REL/server-tests.log" 2>&1
docker run --rm --network none --memory=1024m --cpus=1 --shm-size=256m --entrypoint sh -e CHROMIUM_PATH=/usr/bin/chromium shn48-frontend-build:1.32.0 -c 'ln -s /app/server /build/server; printf "%s\n" "const {chromium}=require(\"/app/server/node_modules/playwright\");const launch=chromium.launch.bind(chromium);chromium.launch=opts=>launch({...opts,executablePath:\"/usr/bin/chromium\"});" > /tmp/test-browser.cjs; node --require /tmp/test-browser.cjs --test --test-concurrency=1 test/*.test.js' > "$REL/client-tests.log" 2>&1
BUILD
chmod 700 "$REL/build-worker.sh"
nohup bash "$REL/build-worker.sh" > "$REL/build-worker.log" 2>&1 < /dev/null &
echo "CANDIDATE_BUILD_PID=$!"
