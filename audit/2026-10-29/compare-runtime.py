import pathlib,json,hashlib
root=pathlib.Path(__file__).resolve().parents[2]
raw=json.loads((root/'audit/2026-10-29/production-node-results.json').read_text(encoding='utf-8'))
d=json.loads(raw[0]['stdout'])
result={'compared':0,'matching':0,'differences':[],'remoteOnly':[]}
for rel,remote in d['runtimeHashes'].items():
    p=root/'app'/rel
    if p.exists():
        result['compared']+=1
        actual=hashlib.sha256(p.read_bytes()).hexdigest()
        if remote==actual:result['matching']+=1
        else:result['differences'].append(rel)
    else:result['remoteOnly'].append(rel)
result['backendDifferences']=[p for p in result['differences'] if p.startswith('server/')]
result['backendCompared']=len([p for p in d['runtimeHashes'] if p.startswith('server/') and (root/'app'/p).exists()])
print(json.dumps(result,ensure_ascii=False,indent=2))
(root/'audit/2026-10-29/runtime-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
# summarise selected existing probe results separately
safe={k:v for k,v in d.items() if k!='runtimeHashes'}
(root/'audit/2026-10-29/production-summary.json').write_text(json.dumps(safe,ensure_ascii=False,indent=2),encoding='utf-8')
