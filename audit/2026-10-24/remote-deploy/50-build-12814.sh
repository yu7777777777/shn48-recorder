#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.14
echo "=== build 1.28.14 ==="
rm -rf $STAGE/pkg $STAGE/context
mkdir -p $STAGE/pkg $STAGE/context/client
tar -xzf $STAGE/shn48-1.28.14-20261024-1435.tar.gz -C $STAGE/pkg
cp -a $STAGE/pkg/app/server $STAGE/context/server
cp -a $STAGE/pkg/app/client/dist $STAGE/context/client/dist
cp $STAGE/pkg/app/entrypoint.sh $STAGE/context/entrypoint.sh
cp $STAGE/pkg/app/VERSION $STAGE/context/VERSION
cp $STAGE/pkg/app/Dockerfile.release $STAGE/context/Dockerfile.release
printf 'node_modules\nruntime\n*.log\n' > $STAGE/context/.dockerignore
echo "staged VERSION: $(cat $STAGE/pkg/app/VERSION)"
docker build -q -t shn48-shn48:1.28.14 -f $STAGE/context/Dockerfile.release $STAGE/context 2>&1 | tail -2
echo "=== live roster through new code (real upstream) ==="
docker run --rm --network bridge --entrypoint node shn48-shn48:1.28.14 -e '
const c = require("/app/server/modules/pocket48/members");
c.listRoster({ force: true }).then(r => {
  console.log("source=", r.source, "fallback=", r.fallback, "members=", r.list.length, "groups=", r.groups.length);
  console.log("gorup sample:", r.groups.slice(0, 8).map(g => g.groupName).join(" | "));
  const s = r.list.find(m => m.memberName === "曹可甜");
  console.log("曹可甜:", s ? JSON.stringify(s) : "missing");
}).catch(e => { console.log("ERROR", e.message); process.exit(1); });
' 2>&1 | tail -5
