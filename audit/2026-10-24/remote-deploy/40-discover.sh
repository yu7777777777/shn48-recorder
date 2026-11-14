#!/usr/bin/env bash
echo "=== member_list.html ==="
curl -s -m 25 -o /tmp/ml.html -w 'http=%{http_code} bytes=%{size_download}\n' 'https://www.snh48.com/member_list.html'
echo "--- referenced scripts ---"
grep -oE 'src="[^"]+\.js[^"]*"' /tmp/ml.html | head -20
echo "=== candidate api hosts ==="
for u in \
 'https://www.snh48.com/resource/jsonp/members.php?gid=10' \
 'https://www.snh48.com/api/member/list' \
 'https://www.snh48.com/resource/jsonp/allmembers.php' \
 'https://www.snh48.com/member_list_data.html' ; do
  echo "$u -> $(curl -s -o /dev/null -w '%{http_code}' -m 20 "$u")"
done
