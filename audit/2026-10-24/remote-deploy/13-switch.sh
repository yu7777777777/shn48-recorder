#!/usr/bin/env bash
# Switch the production container to 1.28.12 after an idle re-check.
set -e
PROD=/opt/shn48
NAME=shn48-recorder
NEW_TAG=1.28.12
OLD_TAG=1.28.11
BACKUP=$(ls -d $PROD/backups/release-$NEW_TAG-* | tail -1)
echo "using backup dir: $BACKUP"

echo "=== idle re-check ==="
busy=$(docker exec $NAME node -e '
const fs=require("fs");
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return f}};
const recs=read("/app/data/recordings.json",[]).filter(r=>["recording","processing","waiting_merge"].includes(r.status));
const q=read("/app/data/upload_queue.json",[]).filter(i=>["queued","uploading","paused_recording","waiting_credentials"].includes(i.status));
console.log(recs.length+q.length);')
ff=$(docker exec $NAME sh -c 'ps -eo args | grep -c "[f]fmpeg" || true')
echo "active=$busy ffmpeg=$ff"
if [ "$busy" != "0" ] || [ "$ff" != "0" ]; then echo "ABORT: busy"; exit 2; fi

echo "=== point compose at new tag ==="
sed -i "s#image: shn48-shn48:$OLD_TAG#image: shn48-shn48:$NEW_TAG#" $PROD/docker-compose.yml
grep -n 'image:' $PROD/docker-compose.yml

echo "=== recreate container ==="
cd $PROD
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build 2>&1 | tail -8

echo "=== wait for health ==="
ok=0
for i in $(seq 1 45); do
  sleep 2
  if curl -fsS http://127.0.0.1:3000/api/public/health >/tmp/prod-health.json 2>/dev/null; then
    echo "health: $(cat /tmp/prod-health.json)"; ok=1; break
  fi
done
if [ $ok -ne 1 ]; then
  echo "HEALTH FAILED - rolling back"
  docker logs --tail 40 $NAME 2>&1
  cp $BACKUP/docker-compose.yml $PROD/docker-compose.yml
  docker-compose -f $PROD/docker-compose.yml -f $PROD/docker-compose.public.yml up -d --no-build 2>&1 | tail -5
  exit 3
fi
echo "=== container / image ==="
docker inspect -f 'status={{.State.Status}} image={{.Config.Image}} version={{index .Config.Labels "org.opencontainers.image.version"}}' $NAME
docker exec $NAME cat /app/VERSION
