from pathlib import Path
p=Path(__file__).resolve().parent
old='sha256:38207a421da23e8fbc4ed8ca571dd83362f187848ad7c73a4e55dbef698208b8'
new='sha256:490108adcada5810f724116dbbe5057175e10acf6b988b119b25ae3f5d3a62ba'
def convert(s):return s.replace('1.32.0','1.32.1').replace('1.31.2','1.32.0').replace(old,new).replace(r'1\.31\.2',r'1\.32\.0')
for name in ['preflight.sh','cutover.sh','candidate-smoke.sh','verify-public.py','verify-browser.cjs']:
 target=p/(name.rsplit('.',1)[0]+'-patch.'+name.rsplit('.',1)[1]);target.write_bytes(convert((p/name).read_text(encoding='utf8')).encode('utf8'))
s=convert((p/'sync-built-dist.py').read_text()).replace('frontend-dist-before.tar.gz','frontend-dist-before-patch.tar.gz')
(p/'sync-built-dist-patch.py').write_bytes(s.encode())
s=convert((p/'final-verify.sh').read_text())
s=s[:s.index('tar -czf')]+'''tar -czf "$REL/evidence.tar.gz" -C "$REL" baseline-image.txt candidate-image-id.txt frontend-build.log image-build.log layout-tests.log candidate-smoke.log RUNTIME-SHA256SUMS deploy-result.json runtime-verify.log runtime-verify-final.log stopped-containers-final.txt container-cleanup-result.txt startup-error-check.json cutover-start.txt cutover-complete.txt
'''
(p/'final-verify-patch.sh').write_bytes(s.encode())
