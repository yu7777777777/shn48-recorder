#!/usr/bin/env bash
echo "=== from server host ==="
curl -s -o /dev/null -w 'snh48 http=%{http_code} time=%{time_total}\n' -m 20 'http://h5.snh48.com/resource/jsonp/members.php?gid=10'
curl -s -m 20 'http://h5.snh48.com/resource/jsonp/members.php?gid=10' | head -c 200
echo
curl -s -o /dev/null -w 'snh48-https http=%{http_code}\n' -m 20 'https://h5.snh48.com/resource/jsonp/members.php?gid=10'
curl -s -o /dev/null -w 'roommap http=%{http_code}\n' -m 20 'https://abm48.com/api/public/snh48/room-map'
curl -s -o /dev/null -w 'snh48-root http=%{http_code}\n' -m 20 'http://h5.snh48.com/'
echo "=== from inside container ==="
docker exec -i shn48-recorder sh -s <<'EOF'
node -e '
const url = "http://h5.snh48.com/resource/jsonp/members.php?gid=10";
fetch(url, { signal: AbortSignal.timeout(15000) })
  .then(async r => console.log("container members http=", r.status, (await r.text()).slice(0,120)))
  .catch(e => console.log("container members error=", e.message, e.cause && e.cause.message));
'
EOF
echo "=== app endpoint through admin (unauthenticated will 401; use public app log instead) ==="
docker logs --since 30m shn48-recorder 2>&1 | grep -iE 'member|502|directory' | tail -5
