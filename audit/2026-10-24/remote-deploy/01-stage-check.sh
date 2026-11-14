set -e
STAGE=/opt/shn48/staging/1.28.12
SRC=$STAGE/pkg/app/server
# Copy the new server source into a throwaway container read-only layer, keeping
# the image's own node_modules untouched. Nothing from production data is mounted.
docker run --rm --network none \
  -v $SRC:/incoming:ro \
  -v $STAGE/scan-requires.cjs:/scan.cjs:ro \
  shn48-shn48:1.28.11 sh -c '
set -e
mkdir -p /tmp/check && cp -a /incoming/. /tmp/check/ && rm -rf /tmp/check/node_modules
cd /app/server && node /scan.cjs >/dev/null 2>&1 || true
cd /tmp/check
sed -i "s#process.cwd()#\"/tmp/check\"#" /dev/null 2>/dev/null || true
node -e "
const fs=require(\"fs\"),path=require(\"path\"),mod=require(\"module\"),mods=new Set();
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name===\"node_modules\")continue;const p=path.join(d,e.name);if(e.isDirectory()){walk(p);continue;}if(!e.name.endsWith(\".js\"))continue;for(const m of fs.readFileSync(p,\"utf8\").matchAll(/require\\(\\s*[\"\x27]([^\"\x27]+)[\"\x27]\\s*\\)/g)){const id=m[1];if(id.startsWith(\".\")||id.startsWith(\"/\")||mod.isBuiltin(id))continue;mods.add(id.startsWith(\"@\")?id.split(\"/\").slice(0,2).join(\"/\"):id.split(\"/\")[0]);}}})(
\"/tmp/check\");
fs.writeFileSync(\"/tmp/reqs.txt\",[...mods].sort().join(\"\n\")+\"\n\");console.log(\"external modules:\",mods.size);"
echo "--- resolving against image dependencies ---"
miss=0
for m in $(cat /tmp/reqs.txt); do
  node -e "require.resolve(process.argv[1])" "$m" >/dev/null 2>&1 || { echo "MISSING $m"; miss=1; }
done
[ $miss -eq 0 ] && echo "all dependencies resolvable"
echo "--- syntax check ---"
fail=0
for f in $(find /tmp/check -name "*.js" -not -path "*/node_modules/*"); do node --check "$f" || fail=1; done
[ $fail -eq 0 ] && echo "syntax ok"
'
