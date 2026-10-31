"""Build a narrow, reviewed guide patch against the complete Web/Mini reference.

Run from the repository: python working/tools/prepare-guide-overlay-20261031.py
Reads Git objects and current guide changes. Does not replace product source.
The receipt binds every changed reference/result byte; unchanged reference code,
including older Android regular-expression compatibility, is retained.
"""
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = '51e5782d3117871167783dc53413f0e6e7578bdf'
PREFIX = 'web/web前端/'
OUTPUT = ROOT / 'working/docs/maintenance/alignment-20261031'


def git_text(path):
    return subprocess.check_output(['git', 'show', f'{REFERENCE}:{path}'], cwd=ROOT).decode('utf-8')


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one reviewed patch point: {old[:100]}')
    return text.replace(old, new, 1)


def component(text):
    return text[text.index('const GuideReaderModal = {'):text.index('\nconst DockLauncher = {')]


frozen_patch = OUTPUT / 'guide-overlay-v1.patch'
if frozen_patch.exists():
    receipt = json.loads(frozen_patch.with_suffix('.json').read_text(encoding='utf-8'))
    assert receipt['reference'] == REFERENCE
    assert hashlib.sha256(frozen_patch.read_bytes()).hexdigest() == receipt['patchSha256']
    temporary_root = ROOT / 'working/tmp/alignment-20261031'
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='guide-overlay-verify-', dir=temporary_root) as folder:
        temporary = Path(folder).resolve()
        assert temporary.is_relative_to(temporary_root.resolve())
        for record in receipt['files']:
            target = temporary / record['path']
            assert target.resolve().is_relative_to(temporary)
            data = git_text(record['path']).encode('utf-8')
            assert hashlib.sha256(data).hexdigest() == record['beforeSha256']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        subprocess.run(['git', 'apply', '--check', '--unsafe-paths', '--directory=' + str(temporary), str(frozen_patch)], cwd=ROOT, check=True)
        subprocess.run(['git', 'apply', '--unsafe-paths', '--directory=' + str(temporary), str(frozen_patch)], cwd=ROOT, check=True)
        for record in receipt['files']:
            assert hashlib.sha256((temporary / record['path']).read_bytes()).hexdigest() == record['afterSha256']
        assert temporary.resolve().is_relative_to(temporary_root.resolve())
    print('Verified frozen guide overlay against its reference and all before/after digests.')
    raise SystemExit(0)


changes = {}
before = {}
for name in ['OnlineApp.js', 'GuideArticleFormat.js', 'GuideTopologyChapters.js', 'GuideContent.js',
             'styles.css', 'guide/rule/essential rule.md', 'guide/rule/math rule.md',
             'guide/rule/math rule.en.md', 'tests/verify-guide-content.mjs']:
    before[name] = git_text(PREFIX + name)
    changes[name] = before[name]

current_app = (ROOT / PREFIX / 'OnlineApp.js').read_text(encoding='utf-8')
changes['OnlineApp.js'] = once(changes['OnlineApp.js'], component(changes['OnlineApp.js']), component(current_app))
guide_import = next(line for line in changes['OnlineApp.js'].splitlines() if 'import { ensureGuideRuleImages,' in line)
changes['OnlineApp.js'] = once(changes['OnlineApp.js'], guide_import,
    guide_import + '\nimport { getGuideChapterLinks } from "./GuideArticleFormat.js?v=20261031-guide-reading";')

format_source = (ROOT / PREFIX / 'GuideArticleFormat.js').read_text(encoding='utf-8')
navigation_start = format_source.index('export function getGuideChapterLinks(')
navigation = format_source[navigation_start:format_source.index('\n}\n', navigation_start) + 3]
changes['GuideArticleFormat.js'] = once(changes['GuideArticleFormat.js'], 'let letterOrNumber;', navigation + 'let letterOrNumber;')

topology = (ROOT / PREFIX / 'GuideTopologyChapters.js').read_text(encoding='utf-8')
start = topology.index("    p('闭曲面没有真实边界：")
end = topology.index('\n    m(', start)
addition = topology[start:end] + '\n'
territory_start = changes['GuideTopologyChapters.js'].index("  s('territory',")
target = changes['GuideTopologyChapters.js'].index('\n    m(', territory_start)
changes['GuideTopologyChapters.js'] = (changes['GuideTopologyChapters.js'][:target + 1] + addition
    + changes['GuideTopologyChapters.js'][target + 1:])

# Keep the source-specific code excerpts in why-code intact. Only the two math
# articles receive the corresponding newly authored paragraph.
zh = addition.split("p('", 1)[1].split("',\n", 1)[0]
en = addition.split("\n      '", 1)[1].rsplit("'),", 1)[0]
for language, paragraph in [('zh', zh), ('en', en)]:
    name = 'guide/rule/math rule' + ('.en' if language == 'en' else '') + '.md'
    marker = '\n$$\nR_i=W_i'
    changes[name] = once(changes[name], marker, '\n' + paragraph + '\n' + marker)

zh_shading = '着色保留凸包与收紧轮廓，最后裁剪到棋盘范围，排除棋盘外部和挖掉的孔洞；单根连线不铺领土色。'
en_shading = 'Shading keeps the hull and tightened outlines, then clips them to the actual board, excluding its exterior and removed holes; a single link does not receive a territory fill. '
for name in ['GuideContent.js', 'guide/rule/essential rule.md']:
    changes[name] = once(changes[name], zh_shading, '')
changes['GuideContent.js'] = once(changes['GuideContent.js'], en_shading, '')

style = (ROOT / PREFIX / 'styles.css').read_text(encoding='utf-8')
marker = '/* Guide reading: keep long prose and wide technical material usable at every width. */'
changes['styles.css'] += '\n' + style[style.index(marker):]
changes['tests/verify-guide-content.mjs'] = (ROOT / PREFIX / 'tests/verify-guide-content.mjs').read_text(encoding='utf-8')

patch_parts = []
records = []
digest = lambda text: hashlib.sha256(text.encode('utf-8')).hexdigest()
for name, value in changes.items():
    path = PREFIX + name
    if before[name] == value:
        continue
    patch_parts.append(f'diff --git a/{path} b/{path}\n')
    patch_parts.extend(difflib.unified_diff(before[name].splitlines(True), value.splitlines(True),
        fromfile='a/' + path, tofile='b/' + path))
    records.append({'path': path, 'beforeSha256': digest(before[name]), 'afterSha256': digest(value)})

patch = ''.join(patch_parts)
OUTPUT.mkdir(parents=True, exist_ok=True)
destination = OUTPUT / 'guide-overlay-v1.patch'
receipt_path = OUTPUT / 'guide-overlay-v1.json'
if destination.exists() and destination.read_text(encoding='utf-8') != patch:
    raise SystemExit('Frozen v1 patch already differs; create a new version rather than replacing it.')
destination.write_text(patch, encoding='utf-8', newline='\n')
receipt = {'reference': REFERENCE, 'patch': destination.name, 'patchSha256': digest(patch), 'files': records,
    'retained': ['51e source excerpts', 'runtime Unicode-regex fallback and anchor validation', 'all non-guide OnlineApp behavior']}
receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'patch': str(destination), 'sha256': digest(patch), 'changedFiles': len(records)}, ensure_ascii=False))
