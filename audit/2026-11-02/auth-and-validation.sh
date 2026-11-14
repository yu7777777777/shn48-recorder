set -eu
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs'),auth=require('/app/server/lib/admin-auth');
console.log(JSON.stringify({configured:auth.configured(),environmentLoginValid:auth.verifyCredentials(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD)}));
NODE
REL=/opt/shn48/releases/1.32.2
for f in build.exit client-tests-configured.log validation-worker.log server-tests-r2.log; do if test -f "$REL/$f"; then echo "$f"; tail -n 10 "$REL/$f"; fi; done
