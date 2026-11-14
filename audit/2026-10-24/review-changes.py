"""Read baseline copies and current source; write auditable diffs and hashes only."""
from pathlib import Path
import difflib, hashlib, json
root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
rows, chunks = [], []
for group in sorted(out.glob('before-*')):
    for before in sorted(group.rglob('*')):
        if not before.is_file():
            continue
        rel = before.relative_to(group)
        current = root / rel
        if not current.is_file():
            # A dist backup is a directory; rebuilt assets no longer carry the old names.
            # The rebuilt tree is compared by hash manifest instead of textual diff.
            if group.name == 'before-dist':
                rows.append({'path': 'app/client/dist/' + rel.as_posix(), 'before': None, 'after': None, 'changed': True})
                continue
            raise RuntimeError(f'Missing current source: {rel}')
        a, b = before.read_bytes(), current.read_bytes()
        rows.append({'path': rel.as_posix(), 'before': hashlib.sha256(a).hexdigest(), 'after': hashlib.sha256(b).hexdigest(), 'changed': a != b})
        if a != b:
            chunks.extend(difflib.unified_diff(a.decode('utf-8-sig').splitlines(True), b.decode('utf-8-sig').splitlines(True), fromfile='before/' + rel.as_posix(), tofile='after/' + rel.as_posix()))
for rel in ['app/server/test/audit-public-regressions.test.js', 'app/server/test/audit-analysis-regressions.test.js', 'app/server/test/audit-recorder-regressions.test.js', 'app/client/test/audit-web-regressions.test.js']:
    p = root / rel
    if p.is_file():
        b = p.read_bytes()
        rows.append({'path': rel, 'before': None, 'after': hashlib.sha256(b).hexdigest(), 'changed': True})
        chunks.extend(difflib.unified_diff([], b.decode('utf-8-sig').splitlines(True), fromfile='/dev/null', tofile='after/' + rel))
(out / 'fixes.diff').write_text(''.join(chunks), encoding='utf-8')
(out / 'changed-source-hashes.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'tracked': len(rows), 'changed': sum(row['changed'] for row in rows), 'diff': str(out / 'fixes.diff')}, ensure_ascii=False))
