import json
from pathlib import Path
from xml.etree import ElementTree

root = Path(__file__).parent
manifest = json.loads((root / 'package.json').read_text(encoding='utf-8'))
for locale in ('en', 'zh'):
    data = json.loads((root / 'locale' / f'{locale}.json').read_text(encoding='utf-8'))
    assert data['meta']['title'] and data['meta']['description']
icon = ElementTree.parse(root / 'icon.svg').getroot()
assert icon.tag == '{http://www.w3.org/2000/svg}svg'
assert (root / 'icon.svg').stat().st_size < 262144
assert manifest['exports']['./client'] == './client.js'
for name in ('index.js', 'backend.js', 'artifacts.js', 'client.js', 'cordis.patch.yml', 'README.md', 'icon.svg'):
    assert (root / name).is_file(), name
assert 'node_modules' not in manifest.get('files', [])
print(f"Validated {manifest['name']}@{manifest['version']}: runtime files, manifest, bilingual metadata, original SVG.")
