set -eu
REL=/opt/shn48/releases/1.32.2
for f in build.exit client-tests-configured.log validation-worker.log; do if test -f "$REL/$f"; then echo ==== $f; tail -n 20 "$REL/$f"; fi; done
