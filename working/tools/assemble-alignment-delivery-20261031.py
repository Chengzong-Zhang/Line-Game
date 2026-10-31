"""Collect explicitly selected local candidates; never replace an old delivery."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import zipfile


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('selection', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    allowed = (root / 'working/local_artifacts/alignment-20261031').resolve()
    dest = args.destination.resolve()
    if not dest.is_relative_to(allowed) or dest == allowed or dest.exists():
        raise RuntimeError('Use a new delivery directory beneath this task’s local artifacts.')
    selection = json.loads(args.selection.read_text(encoding='utf-8'))
    if not selection.get('artifacts'):
        raise RuntimeError('No selected candidate artifacts.')
    inputs, output_names = [], set()
    denied = re.compile(r'(?:^|/)(?:node_modules|\.git|__pycache__)(?:/|$)|\.(?:pem|p12|pfx|jks|key)$|(?:^|/)\.env(?:$|\.)',re.I)
    for item in selection['artifacts']:
        src = Path(item['source']).resolve(strict=True)
        name = item['name']
        if not src.is_relative_to(root) or Path(name).name != name or name in output_names:
            raise RuntimeError(f'Unapproved source or duplicate/unsafe output name: {name}')
        output_names.add(name)
        if src.is_file():
            if item.get('sha256') != sha(src): raise RuntimeError(f'Candidate file hash changed: {name}')
            files = {src.name: sha(src)}
        else:
            files = {}
            for file in sorted(src.rglob('*')):
                if file.is_symlink(): raise RuntimeError(f'Linked input is not a frozen artifact: {file}')
                if file.is_file():
                    relative = file.relative_to(src).as_posix()
                    if denied.search(relative): raise RuntimeError(f'Candidate directory contains a prohibited file: {relative}')
                    files[relative] = sha(file)
            if not files: raise RuntimeError(f'Empty candidate directory: {name}')
        inputs.append((item,src,files))
    dest.mkdir(parents=True)
    results = []
    for item,src,files in inputs:
        target = dest / item['name']
        if src.is_file(): shutil.copy2(src,target)
        else:
            if target.suffix.lower() != '.zip': raise RuntimeError('Directory outputs must be explicitly named ZIP archives.')
            with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
                for relative in files: archive.write(src / relative,relative)
            with zipfile.ZipFile(target) as archive:
                if set(archive.namelist()) != set(files): raise RuntimeError('Archive path list differs.')
                for relative,expected in files.items():
                    if hashlib.sha256(archive.read(relative)).hexdigest() != expected:
                        raise RuntimeError(f'Archived bytes differ: {relative}')
        if any(sha(src / relative if src.is_dir() else src) != expected for relative,expected in files.items()):
            raise RuntimeError('Input changed while collecting delivery; preserve this attempt and select a new destination.')
        if src.is_file() and sha(target) != item['sha256']: raise RuntimeError('Copied package differs.')
        results.append({key:value for key,value in item.items() if key not in {'sha256','source'}} |
                       {'source':src.relative_to(root).as_posix(),'name':target.name,'sha256':sha(target),
                        'bytes':target.stat().st_size,'source_files':len(files)})
    receipt = {'schema':'lifeline-local-delivery-v1','common_source':selection['common_source'],
               'artifacts':results,'scope':selection['scope'],'assembler_sha256':sha(Path(__file__))}
    (dest / 'MANIFEST.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'directory':str(dest),'artifacts':len(results),'manifest_sha256':sha(dest/'MANIFEST.json')}))


if __name__ == '__main__':
    main()
