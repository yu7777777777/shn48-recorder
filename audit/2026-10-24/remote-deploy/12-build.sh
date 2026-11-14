#!/usr/bin/env bash
# Deploy 1.28.12. Aborts unless the live/recording/upload state is idle.
set -e
STAGE=/opt/shn48/staging/1.28.12
PKG=$STAGE/pkg/app
PROD=/opt/shn48
NAME=shn48-recorder
NEW_TAG=1.28.12
OLD_TAG=1.28.11
BACKUP=$PROD/backups/release-$NEW_TAG-$(date +%Y%m%d-%H%M%S)

echo "=== preflight: idle check ==="
busy=$(docker exec $NAME node -e '
const fs=require("fs");
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return f}};
const recs=read("/app/data/recordings.json",[]).filter(r=>["recording","processing","waiting_merge"].includes(r.status));
const q=read("/app/data/upload_queue.json",[]).filter(i=>["queued","uploading","paused_recording","waiting_credentials"].includes(i.status));
console.log(recs.length+q.length);')
ff=$(docker exec $NAME sh -c 'ps -eo args | grep -c "[f]fmpeg" || true')
echo "active records+uploads=$busy ffmpeg=$ff"
if [ "$busy" != "0" ] || [ "$ff" != "0" ]; then
  echo "ABORT: production is busy; not switching"
  exit 2
fi

echo "=== backup current compose, VERSION and image tag ==="
mkdir -p $BACKUP
cp $PROD/docker-compose.yml $BACKUP/docker-compose.yml
cp $PROD/docker-compose.public.yml $BACKUP/docker-compose.public.yml
cp $PROD/VERSION $BACKUP/VERSION
docker save $OLD_TAG > /dev/null 2>&1 || true
echo "old image kept locally: shn48-shn48:$OLD_TAG ($(docker images -q shn48-shn48:$OLD_TAG))"
echo "backup dir: $BACKUP"

echo "=== build new image from staged sources ==="
mkdir -p $STAGE/context
rm -rf $STAGE/context/server $STAGE/context/client
cp -a $PKG/server $STAGE/context/server
mkdir -p $STAGE/context/client
cp -a $PKG/client/dist $STAGE/context/client/dist
cp $PKG/entrypoint.sh $STAGE/context/entrypoint.sh
cp $PKG/VERSION $STAGE/context/VERSION
cp $PKG/Dockerfile.release $STAGE/context/Dockerfile.release
touch $STAGE/context/.dockerignore.release
cat > $STAGE/context/.dockerignore <<'EOF'
node_modules
runtime
*.log
EOF
docker build -t shn48-shn48:$NEW_TAG -f $STAGE/context/Dockerfile.release $STAGE/context 2>&1 | tail -15
echo "new image: $(docker images -q shn48-shn48:$NEW_TAG)"
docker run --rm --entrypoint cat shn48-shn48:$NEW_TAG /app/VERSION
