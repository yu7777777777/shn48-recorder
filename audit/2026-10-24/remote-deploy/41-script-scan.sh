#!/usr/bin/env bash
cd /tmp
echo "=== member_list.js ==="
curl -s -m 25 -o ml.js -w 'http=%{http_code} bytes=%{size_download}\n' 'https://www.snh48.com/js/member_list.js'
echo "--- urls / ajax in script ---"
grep -oE "(\$\.(get|post|ajax|getJSON)|fetch|url)[^;]{0,160}" ml.js | head -25
echo "--- any path-like strings ---"
grep -oE "['\"][^'\"]*\.(php|html|json)[^'\"]*['\"]" ml.js | sort -u | head -20
echo "--- jsonp/api mentions ---"
grep -oiE "jsonp|api|resource|member[a-z_]*\.(php|json|html)" ml.js | sort | uniq -c | sort -rn | head -15
echo "=== inline script in page ==="
grep -nE "\.php|\.json|ajax|getJSON|api/" /tmp/ml.html | head -20
