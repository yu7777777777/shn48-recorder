#!/bin/bash
# Post-deploy behavioural verification: confirm the deployed fixes actually behave
# as intended, rather than only checking that the version string changed.
set -u

B=http://127.0.0.1:3000

echo "=== health / version ==="
curl -sS -m 10 "$B/api/public/health"; echo

echo
echo "=== H2: public live list returns a shaped payload (not an error page) ==="
curl -sS -m 15 -o /tmp/live.json -w 'http=%{http_code} bytes=%{size_download}\n' "$B/api/public/live"
python3 -c '
import json
d = json.load(open("/tmp/live.json"))
print("success:", d.get("success"))
key = next((k for k in ("liveList","lives","items","content") if k in d), None)
print("list key:", key, "count:", len(d.get(key) or []) if key else "n/a")
' 2>/dev/null || head -c 300 /tmp/live.json

echo
echo "=== H3/H4: admin endpoints reject unauthenticated access ==="
for p in /api/admin/health /api/admin/config /api/admin/recordings; do
  code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$B$p")
  echo "  $p -> $code"
done

echo
echo "=== auth session reports authenticated:false cleanly (the shape AuthGuard needs) ==="
curl -sS -m 10 "$B/api/admin/auth/session"; echo

echo
echo "=== H6: config read endpoint is reachable when authenticated only (expect 401) ==="
curl -sS -m 10 -o /dev/null -w '  GET /api/admin/config -> %{http_code}\n' "$B/api/admin/config"

echo
echo "=== 容器运行状态与重启次数 ==="
docker inspect shn48-recorder --format 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} image={{.Config.Image}}'

echo
echo "=== 启动日志（确认无异常）==="
docker logs --tail 25 shn48-recorder 2>&1 | tail -25

echo
echo "=== 数据挂载仍在（录像/配置/凭据未被触碰）==="
docker inspect shn48-recorder --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
ls /opt/shn48/runtime/recordings 2>/dev/null | wc -l
echo "  以上为 recordings 目录条目数（应大于 0，证明数据未丢）"
