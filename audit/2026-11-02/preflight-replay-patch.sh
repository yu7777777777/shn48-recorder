set -euo pipefail
BASE=/opt/shn48
REL=$BASE/releases/1.32.2
test "$(readlink -f "$BASE")" = /opt/shn48
test ! -e "$REL"
test "$(docker inspect shn48-recorder -f '{{.Image}}')" = sha256:7db4b15a8285b1eae1aa40afdd69b8c3cb6119e612742bd15b5aa8469cff377c
mkdir -p "$REL"
cp -p "$BASE/docker-compose.yml" "$REL/docker-compose.yml.before"
cp -p "$BASE/docker-compose.public.yml" "$REL/docker-compose.public.yml.before"
cp -p "$BASE/VERSION" "$REL/VERSION.before"
docker inspect -f '{{.Config.Image}} {{.Image}} {{.State.Health.Status}}' shn48-recorder | tee "$REL/baseline-image.txt"
docker tag shn48-shn48:1.32.1 shn48-shn48:rollback-1.32.1-20261102
df -h /
