set -eu
REL=/opt/shn48/releases/1.32.2
for f in frontend-build.log image-build.log server-tests.log client-tests.log build.exit; do if test -f "$REL/$f"; then echo "$f"; tail -n 12 "$REL/$f"; fi; done
docker exec shn48-recorder sh -c 'ps -eo pid,etime,pcpu,args | grep -E "ffmpeg|node" | head -n 20'
