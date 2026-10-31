"""Freeze the current legacy room service without copying accounts or secrets."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(r'C:\coding\py\line game')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    output = Path(tempfile.mkdtemp(prefix='release-all-20261024-legacy-', dir=ROOT / 'local_artifacts'))
    files = ['web/web后端/' + name for name in (
        'server.py', 'online_bots.py', 'database.py', 'models.py', 'sensitive_filter.py', 'training_contributions.py',
        'sensitive_words.txt', 'requirements.txt')]
    files += ['web/tools/online_bot_bridge.mjs']
    files += ['web/tests/' + name for name in (
        'test_online_start_undo.py', 'test_online_bots.py', 'test_hex_online_bots.py')]
    files += ['web/web前端/' + name for name in (
        'index.html', 'GameEngine.js', 'AIEngine.js', 'ThreePlayerAI.js',
        'ThreePlayerModels.js', 'HexPlayerAI.js', 'assets/research-ai/three-player-policy-v1.json',
        'assets/research-ai/three-player-policy-v2.json', 'assets/research-ai/hex-player-policy-v1.json')]
    before = {name: sha(SOURCE / name) for name in files}
    for name in files:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
    assert before == {name: sha(SOURCE / name) for name in files}, 'Concurrent source edit'
    # Current product makes new AI rooms v3. This old assertion was written
    # when DEFAULT_RULES_VERSION was v2; retain its explicit-v1 normalization test.
    test_path = output / 'web/tests/test_hex_online_bots.py'
    source = test_path.read_text(encoding='utf-8')
    old = 'self.assertEqual(settings["rulesVersion"], "territory-v2" if bots else "territory-v1")'
    assert source.count(old) == 1
    test_path.write_text(source.replace(old, 'self.assertEqual(settings["rulesVersion"], server.DEFAULT_RULES_VERSION if bots else "territory-v1")'), encoding='utf-8')
    receipt = {'status': 'FROZEN_CURRENT_LEGACY_SOURCE_BEFORE_BRIDGE_FIX', 'directory': str(output),
               'source': str(SOURCE), 'sourceHashes': before,
               'runtimeOnlyChangesPlanned': ['web/tools/online_bot_bridge.mjs'],
               'testUpdate': 'Use current DEFAULT_RULES_VERSION for explicit v1 bot-room normalization',
               'credentialsIncluded': False, 'deployed': False}
    (output / 'preparation.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': receipt['status'], 'directory': str(output), 'files': len(files)}))


if __name__ == '__main__':
    main()
