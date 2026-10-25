"""Hash-bound terminal-policy release, retaining the complete previous runtime."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/home/ubuntu/line-game')
ARTIFACTS = ROOT / '.deploy-artifacts'
WECHAT = ARTIFACTS / 'wechat-service-20261021/release'
SITE, WX_SITE = ROOT / 'web/web前端', WECHAT / 'web/web前端'
RELEASE = 'web-terminal-policy-20261025-r1'
TARGETS = {
    'legacy-server': ROOT / 'web/web后端/server.py',
    'legacy-bridge': ROOT / 'web/tools/online_bot_bridge.mjs',
    'legacy-runtime': ROOT / 'web/tools/online_bot_runtime.mjs',
    'legacy-package': ROOT / 'web/package.json',
    'wechat-server': WECHAT / 'web/web后端/wechat_online.py',
    'wechat-bridge': WECHAT / 'web/tools/online_bot_bridge.mjs',
    'wechat-runtime': WECHAT / 'web/tools/online_bot_runtime.mjs',
    'wechat-package': WECHAT / 'web/package.json',
    'wechat-validator': WECHAT / 'wechat/minigame/tools/validate-action.mjs',
}
UNITS = ('lifeline-game.service', 'lifeline-wechat.service')
EXTRAS = {'frontend-overlay.zip', 'atomic_frontend_release.py'}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def tree(path):
    digest = hashlib.sha256()
    if not path.is_dir() or path.is_symlink():
        raise RuntimeError('real frontend directory required')
    for file in sorted(path.rglob('*')):
        if file.is_symlink():
            raise RuntimeError('symlink in frontend: ' + str(file))
        if file.is_file():
            name = file.relative_to(path).as_posix().encode()
            digest.update(len(name).to_bytes(8, 'big')); digest.update(name)
            digest.update(bytes.fromhex(sha(file)))
    return digest.hexdigest()


def run(*args, **kwargs):
    if kwargs.get('text'): kwargs.setdefault('encoding', 'utf-8')
    return subprocess.run(args, check=True, timeout=90, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def save(path, body):
    temp = path.with_suffix('.pending')
    temp.write_text(json.dumps(body, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def install(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    old = target.stat() if target.exists() else None
    temp = target.with_name(target.name + '.release-pending')
    if target.is_symlink() or temp.exists():
        raise RuntimeError('unsafe install target: ' + str(target))
    shutil.copyfile(source, temp)
    os.chown(temp, old.st_uid if old else 0, old.st_gid if old else 1000)
    os.chmod(temp, (old.st_mode & 0o777) if old else 0o640)
    temp.replace(target)


def health():
    result = {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for name, url in (('game', 'http://127.0.0.1:8000/api/health'), ('wechat', 'http://127.0.0.1:8006/api/wechat/status')):
        for _ in range(20):
            try:
                with opener.open(url, timeout=3) as response:
                    value = json.load(response)
                if value.get('status') == 'ok' if name == 'game' else value.get('enabled') is True:
                    result[name] = True
                    break
            except (OSError, ValueError):
                time.sleep(.5)
        else:
            raise RuntimeError(name + ' health failed')
    return result


def predecessors(manifest):
    before = manifest['before']
    if sha(SITE / 'release-manifest.json') != before['siteManifest'] or tree(SITE) != before['siteTree']:
        raise RuntimeError('main frontend predecessor changed')
    if tree(WX_SITE) != before['wechatFrontendTree']:
        raise RuntimeError('service frontend predecessor changed')
    for key, target in TARGETS.items():
        if target.is_symlink() or (sha(target) if target.exists() else None) != before[key]:
            raise RuntimeError(key + ' predecessor changed')


def probe(web_root, validator=None):
    node = ARTIFACTS / 'wechat-service-20261021/runtime/node'
    evidence = []
    rule_code = """import {GameEngine} from './web前端/GameEngine.js';
let text='';for await(const c of process.stdin)text+=c;
const {settings,action}=JSON.parse(text),engine=new GameEngine(settings);
if(engine.rulesVersion!=='territory-v3'||engine.currentPlayer!==action.color)throw Error('RULE_CONTEXT');
if(!engine.activePlayers.every(p=>engine.getSnapshot().territories[p].area===1))throw Error('V3_INITIAL_AREA');
const result=action.type==='player_move'?engine.playMove(action.point):engine.skipTurn();
if(!result.success)throw Error('BOT_REPLAY_ILLEGAL');
process.stdout.write(JSON.stringify({success:true,players:engine.activePlayers.length,rulesVersion:engine.rulesVersion,
currentPlayer:engine.currentPlayer,scores:Object.fromEntries(engine.activePlayers.map(p=>[p,engine.getSnapshot().territories[p].area]))}));"""
    for count in (2, 6, 7, 15):
        colors = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN', 'PINK', 'BROWN', 'LIME', 'NAVY', 'GOLD', 'TEAL', 'MAGENTA', 'SLATE', 'CORAL'][:count]
        settings = {'gridSize': 5, 'playerCount': count, 'boardShape': 'triangle' if count == 2 else 'hexagon',
                    'rulesVersion': 'territory-v3', 'startPlayer': 'BLACK', 'playerSetup': {
                        color: {'choice': ('minimax' if count == 2 else 'ai-easy') if color in colors[::2] else 'human',
                                'depth': 2, 'version': '2026092201'} for color in colors}}
        if count > 6:
            # Deterministic explicit starts test every added seat, never a
            # six-corner default. Their format is shared by both clients.
            points = [[x, y] for y in range(9) for x in range(9) if 4 <= x + y <= 12]
            settings.update(startingPointMode='custom', initialPositions={
                color: points[index] for index, color in enumerate(colors)})
        request = {'settings': settings, 'actions': [], 'botColors': colors[::2]}
        bot = json.loads(run(str(node), str(web_root / 'tools/online_bot_bridge.mjs'), input=json.dumps(request), text=True).stdout)
        if not bot.get('success') or bot.get('fallback') or bot.get('action', {}).get('color') != 'BLACK':
            raise RuntimeError('staged actual bot probe failed: ' + str(count))
        rules = json.loads(run(str(node), '--input-type=module', '-e', rule_code, cwd=web_root,
                               input=json.dumps({'settings': settings, 'action': bot['action']}), text=True).stdout)
        if validator:
            checked = json.loads(run(str(node), str(validator), text=True, input=json.dumps({
                'settings': settings, 'actions': [], 'action': bot['action']})).stdout)
            if checked['scores'] != rules['scores'] or checked['currentPlayer'] != rules['currentPlayer'] or checked.get('resignedPlayers') != []:
                raise RuntimeError('installed authoritative validator mismatch')
            rules['authoritativeValidatorMatched'] = True
        evidence.append({'players': count, 'botProfile': bot['botProfile'], 'modelInfo': bot.get('modelInfo'), 'rules': rules})
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('root on Linux required')
    import fcntl
    lock = (ARTIFACTS / 'unified-release.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = args.release_dir.resolve(strict=True)
    if release.parent != ARTIFACTS or release.name != RELEASE:
        raise RuntimeError('unexpected release directory')
    receipt = release / 'deployment.json'
    if receipt.exists():
        raise RuntimeError('existing receipt; inspect it before recovery or retry')
    manifest = json.loads((release / 'deployment-manifest.json').read_text(encoding='utf-8'))
    if (manifest['schemaVersion'] != 1 or manifest['releaseId'] != RELEASE
            or sha(Path(__file__)) != manifest['deployerSha256'] or sha(release / 'payload.zip') != manifest['archiveSha256']):
        raise RuntimeError('release identity/hash mismatch')
    predecessors(manifest)
    health()
    stage = release / 'stage'; stage.mkdir()
    with zipfile.ZipFile(release / 'payload.zip') as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(manifest['payload']) or set(names) != set(TARGETS) | EXTRAS:
            raise RuntimeError('payload inventory mismatch')
        for name, expected in manifest['payload'].items():
            raw = archive.read(name)
            if hashlib.sha256(raw).hexdigest() != expected:
                raise RuntimeError('payload changed: ' + name)
            (stage / name).write_bytes(raw)
    site_ops = stage / 'atomic_frontend_release.py'
    run('python3', str(site_ops), 'prepare', '--release-id', RELEASE, '--archive', str(stage / 'frontend-overlay.zip'),
        '--archive-sha256', manifest['payload']['frontend-overlay.zip'], '--expected-live-tree', manifest['before']['siteTree'])
    site_candidate = ARTIFACTS / (RELEASE + '.candidate')
    if sha(site_candidate / 'release-manifest.json') != manifest['siteCandidateManifestSha256']:
        raise RuntimeError('candidate manifest changed')
    candidate_tree = tree(site_candidate)
    shutil.copytree(site_candidate, stage / 'wechat-candidate')
    for candidate, mode in ((site_candidate, 0o755), (stage / 'wechat-candidate', 0o750)):
        for directory, _, names in os.walk(candidate):
            os.chown(directory, 0, 1000); os.chmod(directory, mode)
            for name in names:
                os.chown(Path(directory) / name, 0, 1000); os.chmod(Path(directory) / name, mode & ~0o111)
    if tree(stage / 'wechat-candidate') != candidate_tree:
        raise RuntimeError('complete frontend copy changed')
    web_probe = stage / 'probe/web'; (web_probe / 'tools').mkdir(parents=True)
    for key, name in (('wechat-bridge', 'tools/online_bot_bridge.mjs'), ('wechat-runtime', 'tools/online_bot_runtime.mjs'), ('wechat-package', 'package.json')):
        shutil.copyfile(stage / key, web_probe / name)
    shutil.copytree(stage / 'wechat-candidate', web_probe / 'web前端')
    staged_probes = probe(web_probe)
    backup = release / 'rollback'; backup.mkdir()
    for key, target in TARGETS.items():
        if target.exists():
            shutil.copy2(target, backup / key)
    predecessors(manifest)
    state = {'status': 'PREFLIGHT_OK', 'release': RELEASE, 'stagedProbes': staged_probes, 'siteChanged': False}
    save(receipt, state)
    try:
        for unit in UNITS:
            run('systemctl', 'stop', unit)
        for key, target in TARGETS.items():
            if not key.startswith('legacy-'): install(stage / key, target)
        WX_SITE.rename(backup / 'wechat-frontend')
        (stage / 'wechat-candidate').rename(WX_SITE)
        for unit in UNITS:
            run('systemctl', 'start', unit)
        state['liveServiceProbes'] = probe(WECHAT / 'web', TARGETS['wechat-validator'])
        state['serviceHealthBeforeSiteSwap'] = health(); save(receipt, state)
        run('systemctl', 'stop', UNITS[0])
        run('python3', str(site_ops), 'activate', '--release-id', RELEASE)
        state['siteChanged'] = True
        for key, target in TARGETS.items():
            if key.startswith('legacy-'): install(stage / key, target)
        run('systemctl', 'start', UNITS[0])
        for key, target in TARGETS.items():
            if sha(target) != manifest['payload'][key]:
                raise RuntimeError(key + ' installed hash mismatch')
        if tree(SITE) != candidate_tree or tree(WX_SITE) != candidate_tree:
            raise RuntimeError('complete frontend post-activation mismatch')
        state.update(status='ACTIVATED_ALL_COMPONENTS_VERIFIED', healthAfter=health())
        save(receipt, state)
    except BaseException as error:
        state.update(status='RECOVERY_RUNNING', error=type(error).__name__); save(receipt, state)
        failures = []
        def recover(label, operation):
            try: operation()
            except BaseException as failure: failures.append(label + ':' + type(failure).__name__)
        def site_rollback():
            if sha(SITE / 'release-manifest.json') != manifest['siteCandidateManifestSha256']:
                return
            if (ARTIFACTS / (RELEASE + '.activation.json')).exists():
                run('python3', str(site_ops), 'rollback', '--release-id', RELEASE)
            else:
                spec = importlib.util.spec_from_file_location('site_ops', site_ops)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                old = next(path for path in (site_candidate, ARTIFACTS / (RELEASE + '.rollback-web前端')) if path.exists())
                module.exchange(SITE, old)
        recover('site', site_rollback)
        for unit in UNITS: recover('stop-' + unit, lambda unit=unit: run('systemctl', 'stop', unit))
        for key, target in TARGETS.items():
            recover(key, lambda key=key, target=target: install(backup / key, target) if (backup / key).exists() else target.unlink(missing_ok=True))
        def service_rollback():
            if (backup / 'wechat-frontend').exists():
                if WX_SITE.exists(): WX_SITE.rename(stage / 'wechat-failed')
                (backup / 'wechat-frontend').rename(WX_SITE)
        recover('service-frontend', service_rollback)
        for unit in UNITS: recover('start-' + unit, lambda unit=unit: run('systemctl', 'start', unit))
        recover('predecessors', lambda: predecessors(manifest)); recover('health', health)
        state.update(status='ROLLBACK_FAILED' if failures else 'ROLLED_BACK_AFTER_FAILURE', rollbackFailures=failures); save(receipt, state)
        raise
    print(json.dumps({'status': state['status'], 'release': RELEASE}))


if __name__ == '__main__':
    main()
