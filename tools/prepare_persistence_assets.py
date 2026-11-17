"""Build-time public capability marker; keep offline integrity manifests exact."""
import hashlib
import json
from pathlib import Path
import sys

MARKER = b'<meta name="server-persistence" content="enabled">'


def prepare(root, app):
    root = Path(root)
    entry = root / ('console/index.html' if app == 'hashwing' else 'index.html')
    original = entry.read_bytes()
    if MARKER not in original:
        if b'<head>' not in original:
            raise ValueError('Entry has no head element')
        entry.write_bytes(original.replace(b'<head>', b'<head>'+MARKER, 1))
    body = entry.read_bytes()
    digest = hashlib.sha256(body).hexdigest()
    manifest = root / 'console/precache.json'
    if app == 'hashwing':
        data = json.loads(manifest.read_text())
        data['sha256']['console/index.html'] = digest
        manifest.write_text(json.dumps(data, indent=2)+'\n')
    elif app in ('cuereport', 'issue-warehouse'):
        worker = root / 'sw.js'
        text = worker.read_text()
        start = text.index('const BUILD = ') + len('const BUILD = ')
        data, length = json.JSONDecoder().raw_decode(text[start:])
        entries = [item for item in data['files'] if item['path'] == 'index.html']
        if len(entries) != 1:
            raise ValueError('Offline build must contain exactly one index')
        entries[0].update(sha256=digest, bytes=len(body))
        data['version'] = hashlib.sha256(json.dumps(data['files'], sort_keys=True).encode()).hexdigest()[:16]
        worker.write_text(text[:start]+json.dumps(data, separators=(',', ':'))+text[start+length:])
        public_manifest = root / 'offline-manifest.json'
        if public_manifest.exists():
            public_manifest.write_text(json.dumps(data, indent=2)+'\n')


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2])
