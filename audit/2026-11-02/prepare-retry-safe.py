from pathlib import Path
import json,os,datetime
assert os.popen("docker inspect shn48-recorder -f '{{.State.Running}}'").read().strip()=='false'
p=Path('/opt/shn48/runtime/data/replay_audit.json');a=json.loads(p.read_text());changed=[]
for i,rid in enumerate(['rec_1793367807736_1gszb','rec_1793455319510_jc46a','rec_1793453189443_mbo87']):
 v=a[rid]
 if v['status'].startswith('repaired_local') or v['status']=='manual':continue
 assert v['status'] in ['repairing','repairable','published_needs_repair'], (rid,v['status'])
 v['status']='published_needs_repair' if v.get('posted') else 'repairable'
 v['nextAttemptAt']=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(milliseconds=i)).isoformat(timespec='milliseconds').replace('+00:00','Z')
 changed.append(rid)
t=p.with_name('replay_audit.release-1.32.3.tmp')
with t.open('x',encoding='utf8') as f:
 json.dump(a,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
t.chmod(0o600);os.replace(t,p)
Path('/opt/shn48/releases/1.32.3/retry-preparation.json').write_text(json.dumps({'scheduledRecordingIds':changed,'changedFields':['status','nextAttemptAt'],'mediaFilesChanged':0},indent=2)+'\n')
print('RESCHEDULED_READONLY_VALIDATION',len(changed))
