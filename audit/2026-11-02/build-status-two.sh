set -eu
REL=/opt/shn48/releases/1.32.4
for name in build.exit frontend-build.log image-build.log server-tests.log frontend-tests.log build-worker.log; do
  if test -f "$REL/$name"; then echo "$name"; tail -n 9 "$REL/$name"; fi
done
