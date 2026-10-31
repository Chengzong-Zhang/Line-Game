"""Prepare an isolated, explicitly gated iOS source candidate from a frozen mobile dist.

No package install, signing, compilation, upload or mutation of mobile inputs.
Run once; refuses to overwrite an existing ios directory. --check revalidates.
"""
import argparse, hashlib, io, json, shutil, tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MOBILE = ROOT / 'local_artifacts/alignment-20261031/mobile/mobile'
IOS = MOBILE / 'ios'
RECEIPT = IOS / 'ios-preparation-receipt.json'
PACKAGE = MOBILE / 'local_artifacts/capacitor-ios-8.5.3.tgz'
TEMPLATE = MOBILE / 'node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz'
SOURCE = MOBILE / 'dist'
BUILD = MOBILE / 'local_artifacts/mobile-web-build-receipt.json'
PIN = '597187fb8f4d1f2409ed742dd0d94008bb6e20270ac9210b4adb07de5401c771'

def sha(data): return hashlib.sha256(data).hexdigest()
def digest(path): return sha(path.read_bytes())
def inventory(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink(): raise RuntimeError(f'Unexpected linked input: {path}')
        if path.is_file(): result[path.relative_to(directory).as_posix()] = digest(path)
    return result

def verify_dist():
    receipt = json.loads(BUILD.read_text(encoding='utf-8'))
    expected = {item['path']: item['sha256'].lower() for item in receipt['dist_files']}
    actual = inventory(SOURCE)
    if actual != expected or len(expected) != receipt['dist_file_count']:
        raise RuntimeError('dist differs from its build receipt; rebuild or freeze it before iOS preparation.')
    return receipt, actual

def check():
    saved = json.loads(RECEIPT.read_text(encoding='utf-8'))
    receipt, source = verify_dist()
    if receipt['dist_manifest_sha256'] != saved['dist_manifest_sha256'] or source != saved['source_files']:
        raise RuntimeError('Source dist changed after preparation.')
    if inventory(IOS / 'App/App/public') != saved['public_files']:
        raise RuntimeError('The iOS resource copy changed after preparation.')
    if inventory(IOS / 'App') != saved['project_files']:
        raise RuntimeError('The iOS project source changed after preparation.')
    if digest(TEMPLATE) != saved['template_sha256'] or digest(PACKAGE) != PIN:
        raise RuntimeError('Pinned official inputs changed.')
    if digest(Path(__file__)) != saved['preparation_script_sha256']:
        raise RuntimeError('Preparation script differs from the recorded version.')
    print('iOS source and guarded resource snapshot: PASS (static verification only)')

def main():
    global IOS, RECEIPT
    parser=argparse.ArgumentParser(); parser.add_argument('--check',action='store_true')
    parser.add_argument('--output', type=Path, help='new iOS output inside this workspace; defaults to candidate mobile/ios')
    args=parser.parse_args()
    if args.output:
        proposed = args.output.resolve()
        if not proposed.is_relative_to(ROOT.resolve()): raise RuntimeError('Output must stay in the workspace.')
        IOS = proposed; RECEIPT = IOS / 'ios-preparation-receipt.json'
    if args.check: return check()
    if IOS.exists(): raise RuntimeError('ios already exists; preserve it and choose a fresh candidate rather than overwrite.')
    if digest(PACKAGE) != PIN: raise RuntimeError('The official @capacitor/ios package digest does not match the reviewed 8.5.3 input.')
    with tarfile.open(PACKAGE, 'r:gz') as archive:
        meta=json.load(archive.extractfile('package/package.json'))
    if meta['name'] != '@capacitor/ios' or meta['version'] != '8.5.3': raise RuntimeError('Unexpected iOS package identity.')
    for name in ('core','cli'):
        installed=json.loads((MOBILE / 'node_modules/@capacitor' / name / 'package.json').read_text(encoding='utf-8'))
        if installed['version'] != '8.5.3': raise RuntimeError('Capacitor versions must match 8.5.3.')
    config=(MOBILE/'capacitor.config.ts').read_text(encoding='utf-8')
    if "appId: 'cn.lifelinegame.mobile'" not in config or "appName: '生命线'" not in config or "webDir: 'dist'" not in config:
        raise RuntimeError('Unexpected app identity or asset source.')
    build, source = verify_dist()
    # The checked official CLI template contains regular files only; extract
    # member-by-member into a new output to avoid path/link traversal.
    IOS.mkdir()
    with tarfile.open(TEMPLATE, 'r:gz') as archive:
        for member in archive.getmembers():
            path=Path(member.name)
            if path.is_absolute() or '..' in path.parts or not member.isfile(): raise RuntimeError('Unsafe template member.')
            target=IOS/path; target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(member) as src, target.open('wb') as dest: shutil.copyfileobj(src,dest)
    project=IOS/'App/App.xcodeproj/project.pbxproj'
    text=project.read_text(encoding='utf-8'); old='PRODUCT_BUNDLE_IDENTIFIER = com.getcapacitor.App;'
    if text.count(old)!=2: raise RuntimeError('Unexpected Xcode template identity.')
    project.write_text(text.replace(old,'PRODUCT_BUNDLE_IDENTIFIER = cn.lifelinegame.mobile;'),encoding='utf-8',newline='')
    plist=IOS/'App/App/Info.plist';text=plist.read_text(encoding='utf-8')
    if text.count('<string>My App</string>')!=1: raise RuntimeError('Unexpected display name template.')
    plist.write_text(text.replace('<string>My App</string>','<string>生命线</string>'),encoding='utf-8',newline='')
    swift=IOS/'App/CapApp-SPM/Package.swift';text=swift.read_text(encoding='utf-8')
    old='.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")'
    if text.count(old)!=1: raise RuntimeError('Unexpected Swift package template.')
    swift.write_text(text.replace(old,'.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3")'),encoding='utf-8',newline='')
    (IOS/'App/App/capacitor.config.json').write_text(json.dumps({'appId':'cn.lifelinegame.mobile','appName':'生命线','webDir':'dist','server':{'androidScheme':'https'}},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    # The official CLI generates an empty Cordova widget configuration when
    # no Cordova plugins/preferences are declared; the Xcode template refers to it.
    (IOS/'App/App/config.xml').write_text("<?xml version='1.0' encoding='utf-8'?>\n<widget version=\"1.0.0\" xmlns=\"http://www.w3.org/ns/widgets\" xmlns:cdv=\"http://cordova.apache.org/ns/1.0\">\n</widget>\n", encoding='utf-8')
    public=IOS/'App/App/public';shutil.copytree(SOURCE,public)
    # A native iOS bridge is not implemented; never enter Android-specific
    # bootstrap or imply local/credential durability. Preserve the exact entry
    # next to the gate for future native implementation and reproducibility.
    entry=public/'mobile-entry.js';shutil.copy2(entry,public/'mobile-entry.upstream.js')
    gate='''// iOS diagnostic capability gate: native storage and credentials are not implemented.\nconst app = document.getElementById("app");\nconst zh = !navigator.language?.toLowerCase().startsWith("en");\nconst box = document.createElement("main");\nbox.setAttribute("role", "alert");\nbox.style.cssText = "max-width:36rem;margin:12vh auto;padding:1.5rem;font:16px/1.6 system-ui;color:#243c33";\nconst title = document.createElement("h1"); title.textContent = zh ? "iOS 版本准备中" : "iOS version in preparation";\nconst detail = document.createElement("p"); detail.textContent = zh ? "原生存档与账号保护尚未完成，当前构建仅供工程验证。" : "Native game storage and account protection are not implemented. This build is for engineering verification.";\nbox.append(title, detail); app.replaceChildren(box);\n'''
    entry.write_text(gate,encoding='utf-8',newline='')
    if inventory(SOURCE)!=source: raise RuntimeError('dist changed while preparing iOS; discard this candidate and rebuild.')
    output=inventory(public); expected={**source,'mobile-entry.upstream.js':source['mobile-entry.js'],'mobile-entry.js':sha(gate.encode())}
    if output!=expected: raise RuntimeError('iOS public assets do not match the source and declared gate.')
    record={'status':'SOURCE-PREPARED-NATIVE-GATED','app_id':'cn.lifelinegame.mobile','app_name':'生命线','capacitor_version':'8.5.3',
      'official_npm_package_sha256':PIN,'template_sha256':digest(TEMPLATE),'dist_manifest_sha256':build['dist_manifest_sha256'],
      'source_files':source,'public_files':output,'project_files':inventory(IOS/'App'),'preparation_script_sha256':digest(Path(__file__)),
      'gate':'mobile-entry.js blocks startup pending iOS native bridges; upstream entry is retained as mobile-entry.upstream.js',
      'limits':['no Xcode build','no iOS native bridge','no signing','no installation','no release']}
    RECEIPT.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');check()
if __name__=='__main__': main()
