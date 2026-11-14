set -euo pipefail
cd /opt/shn48
test "$(docker inspect shn48-recorder -f '{{.Config.Image}}')" = shn48-shn48:1.32.3
docker exec -i shn48-recorder node <<'NODE'
const fs=require('fs');const a=JSON.parse(fs.readFileSync('/app/data/replay_audit.json'));if(Object.values(a).some(x=>x.status==='repairing'))throw Error('Repair still active');
for(const key of ['recordings','upload_queue','analysis_jobs','replay_import_jobs','backup115/jobs','export_jobs']){try{const rows=JSON.parse(fs.readFileSync('/app/data/'+key+'.json'));if(Array.isArray(rows)&&rows.some(x=>['recording','processing','uploading','queued','running','hashing','verifying','downloading'].includes(x.status)))throw Error('Active task: '+key);}catch(e){if(e.code!=='ENOENT')throw e;}}
NODE
docker stop --time 40 shn48-recorder
trap 'docker start shn48-recorder >/dev/null || true' EXIT
python3 - <<'PY'
from pathlib import Path
import json,hashlib,os,shutil,datetime
base=Path('/opt/shn48');data=base/'runtime/data';root=base/'runtime/recordings/.official-replays';rel=base/'releases/1.32.3'
assert os.popen("docker inspect shn48-recorder -f '{{.State.Running}}'").read().strip()=='false'
backup=base/'backups/release-1.32.3-cache-preservation';backup.mkdir(mode=0o700)
shutil.copy2(data/'replay_audit.json',backup/'replay_audit.json.before')
live='1323401690805506048';src=data/'.legacy-rebuild-20261102'/live;dst=root/live
def digest(file):
 h=hashlib.sha256()
 with file.open('rb') as f:
  for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
 return h.hexdigest()
original_hash='8fd971e6fc08848ffd7e54b4d5f5798259636c426c8397bd05a90db0f48e8344'
assert digest(src/'verified.mp4')==original_hash
current=json.loads((dst/'complete.json').read_text());assert digest(dst/'verified.mp4')==current['sha256']
assert current['sha256']=='8862457497dcdd30176829411ad91cd00e81eaa762f2ffce9799b4bc7c14797d'
candidate=dst/'audit-timeline-v1';candidate.mkdir(mode=0o700,exist_ok=True)
assert not (candidate/'verified.mp4').exists()
os.replace(dst/'verified.mp4',candidate/'verified.mp4');os.replace(dst/'complete.json',candidate/'complete.json')
if (dst/'validation.json').exists():os.replace(dst/'validation.json',candidate/'validation.json')
os.replace(src/'verified.mp4',dst/'verified.mp4')
old=json.loads((src/'complete.json').read_text());old['verification']='full'
(dst/'complete.json').write_text(json.dumps(old,indent=2)+'\n');(dst/'complete.json').chmod(0o600)
assert digest(dst/'verified.mp4')==original_hash
a=json.loads((data/'replay_audit.json').read_text())
x=a['rec_1793455319510_jc46a'];x.update(status='manual',reason='官方源含无法无损合并的短分片，已保留原录像',error='官方清单中 0.349 秒短分片有 2 个画面包，合并仅保留 1 个，未通过完整性检查，需人工确认官方源',comparisonBlocked=True,nextAttemptAt=None,retryType=None,lastRepairError=None)
x=a['rec_1793453189443_mbo87'];x.update(status='manual',reason='实际官方回放未明显长于本地，无法补全列表差额',error='官方列表 574.00 秒，实际可下载 330.07 秒，本地 329.38 秒；保留原录像',localSeconds=329.379,downloadableSeconds=330.067,comparisonBlocked=True,nextAttemptAt=None,retryType=None,lastRepairError=None)
tmp=data/'replay_audit.finalize-1.32.3.tmp'
with tmp.open('x',encoding='utf8') as f:
 json.dump(a,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
tmp.chmod(0o600);os.replace(tmp,data/'replay_audit.json')
evidence={'restoredArchiveRecordingId':'rec_1793453189443_mbo87','restoredSha256':original_hash,'restoredBytes':(dst/'verified.mp4').stat().st_size,'normalizedCandidatePreserved':True,'manualRecordingIds':['rec_1793455319510_jc46a','rec_1793453189443_mbo87'],'firstLegacyArchiveSha256':digest(root/'1323410706013163520/verified.mp4')}
assert evidence['firstLegacyArchiveSha256']=='79fb7055c4a5e2ca9ed9235e9ed9e7dab3dc65fdd74988a1b913386358ae622f'
(rel/'cache-preservation-result.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence))
PY
docker start shn48-recorder
trap - EXIT
