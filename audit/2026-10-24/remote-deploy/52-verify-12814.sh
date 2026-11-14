#!/usr/bin/env bash
NAME=shn48-recorder
echo "=== health ==="
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}}' $NAME
echo "=== public endpoints ==="
for p in / /replays /admin /api/public/health; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' "http://<SERVER_IP>:3000$p")"
done
echo "admin-api-unauth -> $(curl -s -o /dev/null -w '%{http_code}' http://<SERVER_IP>:3000/api/admin/config)"
echo "=== groups served to the automation page (via module, same code path) ==="
docker exec $NAME node -e '
const c = require("/app/server/modules/pocket48/members");
c.listRoster({}).then(r => {
  const byGroup = {};
  for (const m of r.list) byGroup[m.groupName.split(" · ")[0]] = (byGroup[m.groupName.split(" · ")[0]] || 0) + 1;
  console.log("members:", r.list.length, "groups:", r.groups.length, "source:", r.source);
  console.log("by 分团:", Object.entries(byGroup).map(([k, v]) => k + "=" + v).join(" "));
  console.log("team groups sample:", r.groups.slice(0, 6).map(g => g.groupName).join(" | "));
}).catch(e => console.log("ERROR", e.message));'
echo "=== logs ==="
docker logs --since 5m $NAME 2>&1 | grep -icE 'error|unhandled' || true
docker logs --tail 3 $NAME 2>&1
