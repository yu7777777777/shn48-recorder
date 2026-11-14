#!/usr/bin/env bash
cd /tmp
echo "=== how get_members builds its URL ==="
grep -n "function get_members" -A 12 ml.js
echo "=== the url variable ==="
grep -nE "url\s*=\s*" ml.js | head -5
echo "=== nav_map.html (group definitions) ==="
curl -s -m 20 'https://www.snh48.com/nav_map.html' | head -c 1500
