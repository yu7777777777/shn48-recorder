set -eu
for id in 1323430498988265472 1323043490600128512 1323410706013163520 1323401690805506048; do
 docker exec shn48-recorder sh -c "find /app/recordings/.official-replays/$id -maxdepth 1 -type f -printf '%f %s bytes\n' 2>/dev/null || true"
done
