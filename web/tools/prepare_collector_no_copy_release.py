"""Prepare a source-bound collector candidate with synthetic ordered-v4 probes."""
import argparse, importlib.util, json, re, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('collector_prepare_base', ROOT / 'web/tools/prepare_collector_unified_release.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
PREVIOUS_SHA256 = '79d9b649811c738a1b7324f4048e7fc09efb21421817c5d41db9717ef55eeaf7'


def prepare(baseline, baseline_sha, previous_manifest, output):
    if not re.fullmatch(r'[0-9a-f]{64}', baseline_sha) or base.digest(baseline.read_bytes()) != baseline_sha:
        raise ValueError('BASELINE_CAPTURE_HASH_MISMATCH')
    previous_raw = previous_manifest.read_bytes()
    if base.digest(previous_raw) != PREVIOUS_SHA256:
        raise ValueError('PREVIOUS_RELEASE_MANIFEST_MISMATCH')
    previous = json.loads(previous_raw); captured = json.loads(baseline.read_text(encoding='utf-8-sig'))
    if captured['files'] != previous['candidate'] or captured['site']['liveRoot'] != previous['site']['liveRoot']:
        raise ValueError('CAPTURE_DOES_NOT_MATCH_PREVIOUS_CANDIDATE')
    base.prepare(baseline, output)
    manifest_path = output / 'manifest.json'; doc = json.loads(manifest_path.read_text(encoding='utf8'))
    before, after = doc['baseline'], doc['candidate']
    names = sorted(n for n in set(before) | set(after) if n.startswith('web/backend/'))
    if not names or any(before.get(n) != after.get(n) for n in names):
        raise ValueError('COLLECTOR_BACKEND_OR_SCHEMA_CODE_CHANGED')
    generator = ROOT / 'web/tools/create-ordered-contribution-fixtures.mjs'
    probe = ROOT / 'web/tools/collector_ordered_http_probe.py'
    generators_hash = base.digest(generator.read_bytes()); probe_raw = probe.read_bytes()
    payloads = json.loads(subprocess.check_output(['node', str(generator)],cwd=ROOT,timeout=60))
    if set(payloads) != {'ordered_grid','ordered_topology'}: raise ValueError('ORDERED_FIXTURES_INVALID')
    folder = output / 'ordered-fixtures'; folder.mkdir()
    for name, value in payloads.items():
        if value['replay']['config']['turnOrder'] != ['PURPLE','BLACK','GREEN','WHITE']: raise ValueError('ORDER_DRIFT')
        (folder / (name+'.json')).write_text(json.dumps(value,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    if base.digest(generator.read_bytes()) != generators_hash or probe.read_bytes() != probe_raw:
        raise ValueError('PROBE_SOURCE_DRIFT')
    (output / 'collector-ordered-http-probe.py').write_bytes(probe_raw)
    doc.update(noProductionDatabaseCopy=True, previousReleaseManifestSha256=PREVIOUS_SHA256,
        baselineCaptureSha256=baseline_sha, orderedFixtureHashes=base.inventory(folder),
        orderedProbeSha256=base.digest(probe_raw), orderedFixtureGeneratorSha256=generators_hash,
        schemaAssurance='backend code identical to captured baseline; synthetic baseline schema exercised')
    manifest_path.write_text(json.dumps(doc,indent=2,ensure_ascii=False),encoding='utf8')
    result={'status':'FROZEN_NOT_DEPLOYED','runtimeFiles':len(after),'manifestSha256':base.digest(manifest_path.read_bytes()),
            'baselineCaptureSha256':baseline_sha,'previousReleaseManifestSha256':PREVIOUS_SHA256,
            'orderedFixtureHashes':doc['orderedFixtureHashes'],'containsProductionData':False,'productionDatabaseCopied':False}
    (output/'preparation-no-copy.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    return result

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--baseline',type=Path,required=True)
    p.add_argument('--baseline-sha256',required=True); p.add_argument('--previous-manifest',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args(); print(json.dumps(prepare(a.baseline,a.baseline_sha256,a.previous_manifest,a.output)))
