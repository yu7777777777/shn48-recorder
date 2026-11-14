set -eu
docker exec shn48-recorder sh -c 'ps -eo pid,etime,pcpu,args | grep -E "ffmpeg|node" | head -n 20'
