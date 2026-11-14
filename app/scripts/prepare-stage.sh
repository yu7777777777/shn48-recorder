#!/bin/bash
# Make the staging tree a complete, testable copy of the server sources.
#
# Only the changed files were uploaded, so the baseline tree supplies everything
# else: the test suite and its fixtures. node_modules comes from the image at run
# time (see run-server-tests.sh) because the server cannot reach Docker Hub.
# Production files are only read, never written.
set -eu

STAGE=/opt/shn48/releases/1.17.6/staged
PROD=/opt/shn48

echo "=== 从生产补齐 test/ 与 assets/ ==="
if [ ! -d "$PROD/server/test" ]; then echo "production test dir missing"; exit 1; fi
rm -rf "$STAGE/server/test"
cp -r "$PROD/server/test" "$STAGE/server/test"
if [ -d "$PROD/server/assets" ]; then
  rm -rf "$STAGE/server/assets"
  cp -r "$PROD/server/assets" "$STAGE/server/assets"
fi
echo "  test 文件数: $(find "$STAGE/server/test" -type f | wc -l)"
echo "  assets: $([ -d "$STAGE/server/assets" ] && echo present || echo absent)"

echo
echo "=== 确认改动过的源码是暂存版 ==="
for pair in \
  "server/lib/version.js:readVersionFile" \
  "server/modules/analysis/offline.js:listActive" \
  "server/lib/cli.js:timeoutMs" \
  "server/routes/config.js:renameSync" ; do
  file=${pair%%:*}; needle=${pair##*:}
  if grep -q "$needle" "$STAGE/$file"; then
    echo "  OK    $file contains $needle"
  else
    echo "  FAIL  $file missing $needle"
    exit 1
  fi
done

echo
echo "=== 确认离线转写测试文件是原始基线版本 ==="
if grep -q 'live.listActive' "$STAGE/server/test/offline.test.js"; then
  echo "  FAIL  测试文件含我的改动，应已回退"
  exit 1
fi
echo "  OK    offline.test.js 为基线版本（status:'recording' 行模拟录制）"

echo
echo "暂存树已就绪"
