set -eu
docker exec shn48-recorder ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height,duration,start_time,nb_frames -of json /app/recordings/.replay-diagnostics-20261102/1323430498988265472/replay.processing.mp4
