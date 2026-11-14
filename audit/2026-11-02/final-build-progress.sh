set -eu
REL=/opt/shn48/releases/1.32.2
for f in build.exit server-tests-final.log final-build-worker.log; do if test -f "$REL/$f"; then echo "$f"; tail -n 14 "$REL/$f"; fi; done
