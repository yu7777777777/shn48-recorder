from pathlib import Path
import json,hashlib,os,datetime
base=Path('/opt/shn48');rel=base/'releases/1.32.2';data=base/'runtime/data';recordings=base/'runtime/recordings'
assert os.popen("docker inspect shn48-recorder -f '{{.State.Running}}'").read().strip()=='false'
evidence=[]
for live_id,periods in [('1323430498988265472',4),('1323043490600128512',3)]:
 src=data/'.replay-diagnostics-20261102'/live_id
 dst=recordings/'.official-replays'/live_id
 assert src.resolve()==src and dst.resolve()==dst
 c=json.loads((src/'complete.json').read_text());v=json.loads((src/'validation.json').read_text())
 assert c['liveId']==live_id and c['verification']=='fast'
 assert len(v['periods'])==periods and not v.get('error')
 assert v['expectedPackets']==v['actualPackets'] and all(x['packets']>0 for x in v['actualPackets'])
 checksum=hashlib.sha256()
 with (src/'verified.mp4').open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):checksum.update(chunk)
 assert checksum.hexdigest()==c['sha256']
 assert not (dst/'verified.mp4').exists() and not (dst/'complete.json').exists()
 dst.mkdir(mode=0o700,parents=True,exist_ok=True)
 os.replace(src/'verified.mp4',dst/'verified.mp4')
 # These caches have already passed the new continuity and packet-count checks.
 c['timelineVersion']=1
 (dst/'complete.json').write_text(json.dumps(c,ensure_ascii=False,indent=2)+'\n');(dst/'complete.json').chmod(0o600)
 os.replace(src/'validation.json',dst/'validation.json')
 evidence.append({'liveId':live_id,'sha256':c['sha256'],'durationSeconds':c['durationSeconds'],'verification':'fast; full decode required by production repair'})
audit_file=data/'replay_audit.json';audit=json.loads(audit_file.read_text())
ids=['rec_1793460029674_k5sw2','rec_1793367807736_1gszb','rec_1793455319510_jc46a','rec_1793453189443_mbo87']
now=datetime.datetime.now(datetime.timezone.utc)
for i,rid in enumerate(ids):
 item=audit[rid];assert item['status'] in ['repairable','published_needs_repair']
 item['nextAttemptAt']=(now+datetime.timedelta(milliseconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z')
 item['retryType']='repair'
tmp=audit_file.with_name('replay_audit.release-1.32.2.tmp')
with tmp.open('x',encoding='utf8') as f:
 json.dump(audit,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
tmp.chmod(0o600);os.replace(tmp,audit_file)
(rel/'retry-preparation.json').write_text(json.dumps({'caches':evidence,'scheduledRecordingIds':ids,'changedAuditFields':['nextAttemptAt','retryType']},indent=2)+'\n')
print('PREPARED_VERIFIED_CACHES_AND_RETRY_TIMES',len(ids))
