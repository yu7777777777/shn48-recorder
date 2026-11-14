set -eu
docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}'
ps -eo pid,etimes,pcpu,args | grep -E 'node --test|archive-integration|build-worker.sh|ffmpeg' | grep -v grep
tail -n 20 /opt/shn48/releases/1.32.4/server-tests.log
