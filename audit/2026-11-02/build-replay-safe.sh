set -euo pipefail
REL=/opt/shn48/releases/1.32.3
test ! -e "$REL"
test "$(docker inspect shn48-recorder -f '{{.Image}}')" = sha256:a65c4bca4419fe6b72f9197550c4f608cb568b1a60fcaa2923b0facb9d5249d9
mkdir "$REL"
cp -p /opt/shn48/docker-compose.yml "$REL/docker-compose.yml.before"
cp -p /opt/shn48/docker-compose.public.yml "$REL/docker-compose.public.yml.before"
cp -p /opt/shn48/VERSION "$REL/VERSION.before"
docker tag shn48-shn48:1.32.2 shn48-shn48:rollback-1.32.2-20261102
