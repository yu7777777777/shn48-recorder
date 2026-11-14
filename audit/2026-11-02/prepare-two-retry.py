from pathlib import Path
import json,os,datetime,subprocess
assert subprocess.check_output(['docker','inspect','shn48-recorder','-f','{{.State.Running}}']).strip()==b'false'
p=Path('/opt/shn48/runtime/data/replay_audit.json');a=json.loads(p.read_text());changed=[]
for i,(rid,listed) in enumerate([('rec_1793455319510_jc46a',589),('rec_1793453189443_mbo87',574)]):
 v=a[rid]
 assert v['posted'] is True,(rid,'posted')
 assert v['status'] in ['manual','repairable','published_needs_repair'],(rid,v['status'])
 assert v['officialSeconds']==listed,(rid,'official listing changed')
 v.update(status='published_needs_repair',manualRepair=True,nextAttemptAt=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(milliseconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z'))
 changed.append(rid)
t=p.with_name('replay_audit.release-1.32.4.tmp')
with t.open('x',encoding='utf8') as f:
 json.dump(a,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
t.chmod(0o600);os.replace(t,p)
Path('/opt/shn48/releases/1.32.4/retry-preparation.json').write_text(json.dumps({'scheduledRecordingIds':changed,'changedFields':['status','manualRepair','nextAttemptAt'],'mediaFilesChanged':0},indent=2)+'\n')
print('SCHEDULED_MANUAL_SOURCE_REPAIR',len(changed))
