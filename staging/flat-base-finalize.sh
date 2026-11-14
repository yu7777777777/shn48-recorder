set -e
D=/root/flatbuild-1.27.8
echo "BASE_ID $(docker image inspect shn48-shn48:1.27.7-flat-20261022 --format '{{.Id}}')"
echo "WORKDIR $(docker image inspect shn48-shn48:1.27.7-flat-20261022 --format '{{.Config.WorkingDir}}')"
docker run --rm --network none --entrypoint /usr/bin/tini shn48-shn48:1.27.7-flat-20261022 -- /bin/sh -c 'cd /app/server && test -f package.json && echo WORKDIR_OK && cat /app/VERSION'
docker rmi -f flat-base-test >/dev/null 2>&1 || true
docker rmi -f probe-tmp >/dev/null 2>&1 || true
rm -rf /root/ftpdir /root/rootfs-1.27.8.tar /tmp/rootfs-probe.tar /tmp/*.log /root/layerlist.txt /root/cfg.json
echo "CLEANED"
df -h / | tail -n 1
