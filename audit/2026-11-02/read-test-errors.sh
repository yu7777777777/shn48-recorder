set -eu
REL=/opt/shn48/releases/1.32.2
grep -A 20 -B 3 '^not ok' "$REL/client-tests.log" | head -n 180
