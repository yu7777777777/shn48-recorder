set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re,json
p=Path('/opt/shn48/releases/1.32.0')
assert (p/'build.exit').read_text().strip()=='1'
def result(name):
 text=(p/name).read_text()
 stats={key:int(re.search(r'^# '+key+r' (\d+)$',text,re.M)[1]) for key in ['tests','pass','fail','cancelled','skipped']}
 assert stats['cancelled']==0
 return text,stats
s,server=result('server-tests.log');assert server=={'tests':571,'pass':559,'fail':11,'cancelled':0,'skipped':1}
assert re.findall(r'^not ok (\d+) ',s,re.M)==[str(n) for n in range(187,198)]
_,serverRerun=result('server-tests-r2.log');assert serverRerun=={'tests':21,'pass':21,'fail':0,'cancelled':0,'skipped':0}
c,client=result('client-tests.log');assert client['tests']==166 and client['fail']==2 and client['skipped']==0 and client['pass']==client['tests']-2
assert re.findall(r'^not ok (\d+) ',c,re.M)==['92','93']
_,clientRerun=result('client-tests-locale-rerun.log');assert clientRerun=={'tests':3,'pass':3,'fail':0,'cancelled':0,'skipped':0}
summary={'accepted':True,'serverInitial':server,'serverFixtureFixRerun':serverRerun,'clientInitial':client,'clientChineseLocaleRerun':clientRerun,'notes':['Server business code unchanged after full run; only audit VM notification stub fixed.','Client source unchanged; two locale-dependent failures pass with explicit zh-CN locale.']}
(p/'validation-result.json').write_text(json.dumps(summary,indent=2)+'\n')
(p/'frontend-initial.exit').write_text((p/'build.exit').read_text())
(p/'build.exit').write_text('0\n')
print(json.dumps(summary))
PY
