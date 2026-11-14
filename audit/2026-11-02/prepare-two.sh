set -euo pipefail
REL=/opt/shn48/releases/1.32.4
test ! -e "$REL"
test "$(docker inspect shn48-recorder -f '{{.Image}}')" = sha256:26f36aa96d977447eca9451fbf490ccddf8bf0281a77fe2fbd564b85e1c79279
mkdir "$REL"
cp -p /opt/shn48/docker-compose.yml "$REL/docker-compose.yml.before"
cp -p /opt/shn48/docker-compose.public.yml "$REL/docker-compose.public.yml.before"
cp -p /opt/shn48/VERSION "$REL/VERSION.before"
docker tag shn48-shn48:1.32.3 shn48-shn48:rollback-1.32.3-20261102
