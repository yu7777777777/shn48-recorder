#!/usr/bin/env bash
set -e
STAGE=/opt/shn48/staging/1.28.13
DBED=/opt/shn48/staging/1.28.12
echo "=== build 1.28.13 image ==="
rm -rf $STAGE/pkg $STAGE/context
mkdir -p $STAGE/pkg $STAGE/context/client
tar -xzf $STAGE/shn48-1.28.13-20261024-1150.tar.gz -C $STAGE/pkg
cp -a $STAGE/pkg/app/server $STAGE/context/server
cp -a $STAGE/pkg/app/client/dist $STAGE/context/client/dist
cp $STAGE/pkg/app/entrypoint.sh $STAGE/context/entrypoint.sh
cp $STAGE/pkg/app/VERSION $STAGE/context/VERSION
cp $STAGE/pkg/app/Dockerfile.release $STAGE/context/Dockerfile.release
printf 'node_modules\nruntime\n*.log\n' > $STAGE/context/.dockerignore
echo "staged VERSION: $(cat $STAGE/pkg/app/VERSION)"
docker build -q -t shn48-shn48:1.28.13 -f $STAGE/context/Dockerfile.release $STAGE/context 2>&1 | tail -3
echo "image: $(docker images -q shn48-shn48:1.28.13)"
docker run --rm --entrypoint cat shn48-shn48:1.28.13 /app/VERSION

echo "=== live probe: real upstream member roster through the new code ==="
docker run --rm --network bridge --entrypoint node shn48-shn48:1.28.13 -e '
const catalog = require("/app/server/modules/pocket48/members");
catalog.listRoster({ force: true }).then(roster => {
  console.log("fallback=", roster.fallback, "members=", roster.list.length, "groups=", roster.groups.length);
  console.log("sample:", roster.list.slice(0, 5).map(m => m.memberName + ":" + m.memberId).join(", "));
  console.log("has 陈琳:", !!catalog.findMemberByName(roster.list, "陈琳"));
}).catch(e => { console.log("ERROR", e.message); process.exit(1); });
' 2>&1 | tail -6
