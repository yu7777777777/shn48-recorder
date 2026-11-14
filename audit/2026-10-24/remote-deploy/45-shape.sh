#!/usr/bin/env bash
echo "=== allmembers jsonp ==="
for i in 0 1 2; do
  curl -s -m 25 "https://h5.48.cn/resource/json/allmembers_${i}.jsonp?callback=get_members_success" -o /tmp/am$i.txt -w "allmembers_$i http=%{http_code} bytes=%{size_download}\n"
done
echo "--- head of allmembers_0 ---"
head -c 600 /tmp/am0.txt
echo
echo "--- fields present ---"
node -e '
const fs = require("fs");
const raw = fs.readFileSync("/tmp/am0.txt", "utf8");
const start = raw.indexOf("("), end = raw.lastIndexOf(")");
const json = JSON.parse(raw.slice(start + 1, end));
const rows = Array.isArray(json) ? json : (json.data || json.rows || json.list || []);
console.log("wrapper type:", Array.isArray(json) ? "array" : Object.keys(json).join(","));
console.log("rows:", rows.length);
console.log("first row:", JSON.stringify(rows[0]).slice(0, 400));
const keys = new Set(); for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
console.log("all keys:", [...keys].join(","));
const gids = new Set(); for (const r of rows) gids.add(String(r.gid ?? r.group ?? r.gname ?? "?"));
console.log("group values:", [...gids].slice(0, 20).join("|"));
'
