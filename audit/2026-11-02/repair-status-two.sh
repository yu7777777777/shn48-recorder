set -eu
REL=/opt/shn48/releases/1.32.4
for name in offline.exit offline-validation.err offline-worker.log; do
  if test -f "$REL/$name"; then echo "$name"; tail -n 5 "$REL/$name"; fi
done
if test -f "$REL/offline-validation.jsonl"; then
  python3 - <<'PY'
import json,pathlib
p=pathlib.Path('/opt/shn48/releases/1.32.4/offline-validation.jsonl')
for line in p.read_text().splitlines():
 try:
  r=json.loads(line);print(json.dumps({k:r[k] for k in ['recordingId','durationSeconds','sha256','verification'] if k in r}))
 except ValueError:print(line[:300])
PY
fi
docker exec -i shn48-recorder node <<'JS'
const fs=require('fs'),a=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));for(const id of ['rec_1793455319510_jc46a','rec_1793453189443_mbo87']){const r=a[id];console.log(JSON.stringify({id,status:r.status,error:r.error,next:r.nextAttemptAt,official:r.officialSeconds,listed:r.listedOfficialSeconds,manual:r.manualRepair}));}
JS
