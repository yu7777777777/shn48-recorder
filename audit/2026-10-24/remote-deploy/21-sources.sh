#!/usr/bin/env bash
echo "--- room-map payload (fallback source for missing ids) ---"
curl -s -m 20 'https://abm48.com/api/public/snh48/room-map' | head -c 300
echo
echo "--- directory per group ---"
for g in 10 20 30 40 50 60 70; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://h5.snh48.com/resource/jsonp/members.php?gid=$g")
  echo "gid=$g http=$code"
done
echo "--- other snh48 hosts ---"
for u in http://www.snh48.com/ https://www.snh48.com/ https://h5.snh48.com/resource/jsonp/members.php?gid=10; do
  echo "$u -> $(curl -s -o /dev/null -w '%{http_code}' -m 15 "$u")"
done
