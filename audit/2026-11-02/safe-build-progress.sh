set -eu
REL=/opt/shn48/releases/1.32.3
for f in build.exit server-tests.log build-worker.log; do if test -f "$REL/$f"; then echo "$f"; tail -n 12 "$REL/$f"; fi; done
