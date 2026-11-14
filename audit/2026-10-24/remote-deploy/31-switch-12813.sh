#!/usr/bin/env bash
set -e
PROD=/opt/shn48
NAME=shn48-recorder
NEW=1.28.13
OLD=1.28.12
BACKUP=$PROD/backups/release-$NEW-$(date +%Y%m%d-%H%M%S)
busy=$(docker exec $NAME node -e '
const fs=require("fs");
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return f}};
const recs=read("/app/data/recordings.json",[]).filter(r=>["recording","processing","waiting_merge"].includes(r.status));
const q=read("/app/data/upload_queue.json",[]).filter(i=>["queued","uploading","paused_recording","waiting_credentials"].includes(i.status));
console.log(recs.length+q.length);')
ff=$(docker exec $NAME sh -c 'ps -eo args | grep -c "[f]fmpeg" || true')
echo "idle-check active=$busy ffmpeg=$ff"
if [ "$busy" != "0" ] || [ "$ff" != "0" ]; then echo "ABORT busy"; exit 2; fi
mkdir -p $BACKUP
cp $PROD/docker-compose.yml $BACKUP/docker-compose.yml
cp $PROD/docker-compose.public.yml $BACKUP/docker-compose.public.yml
cp $PROD/VERSION $BACKUP/VERSION
echo "backup: $BACKUP"
sed -i "s#image: shn48-shn48:$OLD#image: shn48-shn48:$NEW#" $PROD/docker-compose.yml
grep -n 'image:' $PROD/docker-compose.yml
cd $PROD
docker-compose -f docker-compose.yml -f docker-compose.public.yml up -d --no-build 2>&1 | tail -4
ok=0
for i in $(seq 1 45); do
  sleep 2
  if curl -fsS http://127.0.0.1:3000/api/public/health >/tmp/h.json 2>/dev/null; then ok=1; break; fi
done
if [ $ok -ne 1 ]; then
  echo "HEALTH FAILED - rollback"
  docker logs --tail 40 $NAME 2>&1
  cp $BACKUP/docker-compose.yml $PROD/docker-compose.yml
  docker-compose -f $PROD/docker-compose.yml -f $PROD/docker-compose.public.yml up -d --no-build 2>&1 | tail -3
  exit 3
fi
echo "health: $(cat /tmp/h.json)"
docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} image={{.Config.Image}}' $NAME
