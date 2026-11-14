#!/usr/bin/env bash
set -e
NAME=shn48-recorder
STAGE=/opt/shn48/staging/1.28.13
echo "=== container ==="
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} image={{.Config.Image}} restarts={{.RestartCount}}' $NAME
docker exec $NAME cat /app/VERSION
echo "=== public health ==="
curl -s http://<SERVER_IP>:3000/api/public/health; echo
curl -s -o /dev/null -w 'root=%{http_code}\n' http://<SERVER_IP>:3000/
curl -s -o /dev/null -w 'admin-api-unauth=%{http_code}\n' http://<SERVER_IP>:3000/api/admin/config
echo "=== member roster through the deployed module (real upstream) ==="
docker exec $NAME node -e '
const catalog = require("/app/server/modules/pocket48/members");
catalog.listRoster({ force: true }).then(r => {
  console.log("fallback=", r.fallback, "members=", r.list.length, "groups=", r.groups.map(g=>g.groupName).join(","));
  console.log("陈琳:", catalog.findMemberByName(r.list, "陈琳") ? "found" : "missing");
}).catch(e => { console.log("ERROR", e.message); process.exit(1); });
'
echo "=== runtime hashes ==="
docker exec -i $NAME sh -c 'cat > /tmp/m.txt' < $STAGE/pkg/app/RUNTIME-SHA256SUMS
docker exec -i $NAME sh -c 'cat > /tmp/v.cjs' < /opt/shn48/staging/1.28.12/15-hash-verify.sh 2>/dev/null || true
echo "=== logs ==="
docker logs --tail 6 $NAME 2>&1
