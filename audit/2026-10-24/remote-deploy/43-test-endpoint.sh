#!/usr/bin/env bash
cd /tmp
echo "=== get_members function source ==="
awk '/function get_members/,/^}/' ml.js | head -30
echo "=== candidate endpoints ==="
for u in \
 'https://www.snh48.com/getmembertop.php?source=SNH' \
 'https://www.snh48.com/getmembertop.php?source=snh' \
 'https://www.snh48.com/getmembertop.php?source=1' \
 'https://www.snh48.com/getmembertop.php' ; do
  code=$(curl -s -o /tmp/o.txt -w '%{http_code}' -m 20 "$u")
  echo "$u -> $code  $(head -c 200 /tmp/o.txt | tr -d '\n')"
done
