"""Fail-closed, non-overwriting export of completed transfer_all pilot stages.

The full-config receipt hash and the resume-critical checkpoint config hash
are separate identities by the existing trainer contract. Neither is rewritten.
Only trusted local campaign checkpoints are deserialized, after byte validation.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import sys

RESEARCH = Path(__file__).resolve().parents[1]
ROOT = RESEARCH.parents[1]
sys.path.insert(0, str(RESEARCH))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import torch
import export_web_research_models as legacy
from lifeline_rl.alphazero.checkpoint import _validate_payload
from lifeline_rl.alphazero.config import AlphaZeroConfig, MODEL_KIND_TO_OBSERVATION
from lifeline_rl.alphazero.network import NetworkConfig, build_policy_value_network
from lifeline_rl.alphazero.trainer import AlphaZeroTrainer

CAMPAIGN = RESEARCH / 'results/pilot/size_transfer_v1_transfer_all_3families'
OUTPUT = ROOT / 'web/web前端/assets/research-ai/transfer-v1'
SEEDS = (2026092201, 2026092202, 2026092203)
SIZES = list(range(5, 16))
FEATURES = ['empty', 'own_node', 'own_line', 'opponent_node', 'opponent_line',
            'x/(n-1)', 'y/(n-1)', 'boundary', 'own_start', 'opponent_start', 'clamped_skips/2']

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def check(condition, message):
    if not condition:
        raise ValueError(message)

def audit_stage(run: Path, family: str, seed: int, stage: int):
    check(run.name == f'transfer_all.seed{seed}.stage{stage}', 'stage identity mismatch')
    receipt = read(run / 'stage_receipt.json')
    initialization = read(run / 'initialization.json')
    config = AlphaZeroConfig.load(run / 'resolved_config.json')
    plan_config = AlphaZeroConfig.load(RESEARCH / f'results/pilot/size_transfer_v1_plan_{family}/configs/{run.name}.json')
    check(config.to_dict() == plan_config.to_dict(), f'frozen plan/config mismatch: {run}')
    check(config.model_kind == family and config.observation_mode == MODEL_KIND_TO_OBSERVATION[family], 'model/observation mismatch')
    check(config.seed == seed + (stage - 1) * 1000 and list(config.board_sizes) == SIZES, 'seed/size mismatch')
    check(config.iterations == (48, 64, 80)[stage - 1], 'stage budget mismatch')
    check(receipt.get('status') == 'COMPLETE_NOT_FORMAL' and receipt.get('formal_ready') is False, 'incomplete/non-pilot receipt')
    check(initialization.get('status') == 'INITIALIZED_ONLY', 'initialization incomplete')
    check(receipt['config_hash'] == initialization['config_hash'] == config.fingerprint(), 'full config hash mismatch')
    latest_path = run / 'checkpoints/latest.json'
    latest_raw = latest_path.read_bytes()
    latest = json.loads(latest_raw)
    check(latest['schema'] == {'name': 'lifeline-alphazero-latest', 'version': 1}, 'latest schema mismatch')
    name = latest['checkpoint']
    check(Path(name).name == name and '/' not in name and '\\' not in name, 'checkpoint path escape')
    path = run / 'checkpoints' / name
    raw = path.read_bytes()
    check(digest(raw) == latest['sha256'] and len(raw) == latest['size_bytes'], f'checkpoint SHA/size mismatch: {path}')
    source = AlphaZeroTrainer.current_source_hash()
    check(receipt['source_hash'] == initialization['current_source_hash'] == source, 'receipt/current source mismatch')
    payload = torch.load(io.BytesIO(raw), map_location='cpu', weights_only=False)
    critical = json.loads(config.canonical_json(resume_critical=True))
    _validate_payload(payload, latest, expected_config=critical, expected_config_hash=None,
                      expected_source_hash=source, strict_source=True)
    check(receipt['counters'] == payload['counters'] == payload['trainer_state']['counters'], 'receipt/checkpoint counters mismatch')
    check(receipt['counters']['iteration'] == config.iterations and
          receipt['counters']['games_attempted'] == config.iterations and
          receipt['gradient_updates_committed'] == receipt['counters']['gradient_steps'], 'stage not finished')
    metadata = payload['metadata']
    check(metadata['model_kind'] == family and metadata['observation_mode'] == config.observation_mode, 'metadata identity mismatch')
    network = NetworkConfig(config.hidden_channels, config.message_passing_layers)
    check(metadata['network_config'] == network.to_dict(), 'network metadata mismatch')
    model = build_policy_value_network(family, network)
    state = payload['model_state_dict']
    expected = model.state_dict()
    check(list(state) == list(expected), 'tensor parameter order mismatch')
    for key, tensor in state.items():
        check(isinstance(tensor, torch.Tensor) and tensor.shape == expected[key].shape and
              tensor.dtype == torch.float32 and bool(torch.isfinite(tensor).all()), f'invalid tensor: {key}')
    check(metadata['parameter_count'] == model.parameter_count, 'parameter count mismatch')
    model.load_state_dict(state, strict=True)
    return {'run': run, 'checkpoint': path, 'latest': latest, 'receipt': receipt,
            'initialization': initialization, 'config': config, 'model': model.eval(), 'state': state,
            'binding': {'stage_directory': run.relative_to(ROOT).as_posix(),
                        'checkpoint': path.relative_to(ROOT).as_posix(), 'sha256': latest['sha256'],
                        'config_hash': payload['config_hash'], 'full_config_hash': config.fingerprint(),
                        'source_hash': source, 'receipt_sha256': digest((run / 'stage_receipt.json').read_bytes()),
                        'latest_sha256': digest(latest_raw),
                        'resolved_config_sha256': digest((run / 'resolved_config.json').read_bytes()),
                        'counters': receipt['counters']}}

def audit_campaign(campaign=CAMPAIGN, only=None):
    finals, bindings = [], []
    for family in MODEL_KIND_TO_OBSERVATION:
        pinned = next(item for item in legacy.MODELS if item['model_kind'] == family)
        source_raw = pinned['checkpoint'].read_bytes()
        check(digest(source_raw) == pinned['checkpoint_sha256'], 'original frozen checkpoint SHA mismatch')
        source_payload = torch.load(io.BytesIO(source_raw), map_location='cpu', weights_only=False)
        check(source_payload['source_hash'] == legacy.SOURCE_HASH, 'original frozen source hash mismatch')
        for seed in SEEDS:
            parent = None
            for stage in (1, 2, 3):
                record = audit_stage(campaign / family / f'transfer_all.seed{seed}.stage{stage}', family, seed, stage)
                if parent:
                    src = record['initialization']['source']
                    check(Path(src['path']).resolve() == parent['checkpoint'].resolve() and
                          src['sha256'] == parent['latest']['sha256'] and
                          src['config_hash'] == parent['latest']['config_hash'] and
                          src['source_hash'] == parent['latest']['source_hash'], 'parent provenance mismatch')
                else:
                    src = record['initialization']['source']
                    check(Path(src['path']).resolve() == pinned['checkpoint'].resolve() and
                          src['sha256'] == pinned['checkpoint_sha256'] and
                          src['source_hash'] == source_payload['source_hash'] and
                          src['config_hash'] == source_payload['config_hash'], 'original frozen provenance mismatch')
                bindings.append(record['binding'])
                parent = record
            if only is None or parent['run'].resolve() == only.resolve():
                finals.append(parent)
    check(bool(finals), 'specified stage3 not in audited campaign')
    return finals, bindings

def export_spec(record):
    config = record['config']
    seed = config.seed - 2000
    identifier = f'{config.model_kind.replace("_", "-")}-transfer-v1-seed{seed}'
    chunks, tensors, offset = [], [], 0
    for name, value in record['state'].items():
        array = value.detach().cpu().contiguous().numpy().astype('<f4', copy=False)
        chunks.append(array.tobytes(order='C'))
        tensors.append({'name': name, 'shape': list(value.shape), 'offset': offset, 'length': value.numel()})
        offset += value.numel()
    raw = b''.join(chunks)
    spec = {'id': identifier, 'label': f'{config.model_kind.replace("_", "-")} · seed {seed} · 5–15 · PILOT_ONLY',
            'model_kind': config.model_kind, 'observation_mode': config.observation_mode,
            'seed': seed, 'stage_training_seed': config.seed, 'training_scheme': 'transfer_all', 'stage': 3,
            'trained_board_sizes': SIZES, 'evidence_tier': 'pilot', 'status': 'PILOT_ONLY',
            'compatibility_status': 'COMPATIBILITY_TRIAL', 'compatibility': 'territory-v2 trial',
            'formal_ready': False, 'strength_evaluated': False,
            'browser_inference': {'player_count': 2, 'board_size_range': [5, 15], 'rules_versions': ['territory-v2'],
                                  'evidence': 'interface trials only; no independent playing-strength evaluation'},
            'training_superko_mode': config.superko_mode,
            'puct': {'simulations': config.puct_simulations, 'c_puct': config.c_puct},
            'network': {'hidden_channels': config.hidden_channels, 'message_passing_layers': config.message_passing_layers},
            'input_contract': {'features': FEATURES, 'point_order': 'row-major: y then x',
                               'padding': 'CNN square zero mask after input/each residual block',
                               'relations': ['physical', 'current-player logical', 'opponent logical'],
                               'normalization': 'row degree clamped to at least one'},
            'action_contract': {'point_count': 'n*(n+1)/2', 'pass_index': 'point_count',
                                'pass': 'always legal in nonterminal Web state; maps to skipTurn',
                                'legal_mask_authority': 'Web GameEngine (includes historyHashes)'},
            'checkpoint': record['binding'], 'asset': f'transfer-v1/{identifier}.f32',
            'asset_sha256': digest(raw), 'float_count': offset, 'tensors': tensors}
    return spec, raw

def verify_asset(record, spec, path):
    raw = path.read_bytes()
    expected, expected_raw = export_spec(record)
    check(spec == expected and raw == expected_raw and digest(raw) == spec['asset_sha256'], 'export manifest/bytes mismatch')
    values = np.frombuffer(raw, dtype='<f4')
    for tensor, (name, value) in zip(spec['tensors'], record['state'].items()):
        decoded = values[tensor['offset']:tensor['offset'] + tensor['length']].reshape(tensor['shape'])
        check(tensor['name'] == name and np.array_equal(decoded, value.cpu().numpy()), f'tensor parity mismatch: {name}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign-root', type=Path, default=CAMPAIGN)
    parser.add_argument('--stage-dir', type=Path, help='export a specified stage3 after auditing its complete campaign chain')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    torch.set_num_threads(1)
    finals, bindings = audit_campaign(args.campaign_root, args.stage_dir)
    exports = [export_spec(record) for record in finals]
    manifest = {'schema': {'name': 'lifeline-web-research-ai', 'version': 1},
                'export_format': 'little-endian-f32-state-dict', 'compatibility': 'territory-v2 trial',
                'evidence_tier': 'pilot', 'status': 'PILOT_ONLY', 'compatibility_status': 'COMPATIBILITY_TRIAL',
                'formal_ready': False, 'default_seed': SEEDS[0],
                'default_selection_basis': 'smallest replicate seed for stable UI ordering; not a strength ranking',
                'rules_authority': 'web/web前端/GameEngine.js', 'models': [item[0] for item in exports]}
    output = args.output.resolve()
    if not args.verify_only:
        # All checkpoints are audited before exclusively claiming a new directory.
        output.mkdir(parents=True, exist_ok=False)
        for spec, raw in exports:
            with (output / Path(spec['asset']).name).open('xb') as handle:
                handle.write(raw)
        with (output / 'manifest.json').open('x', encoding='utf-8') as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write('\n')
        with (output / 'export-receipt.json').open('x', encoding='utf-8') as handle:
            json.dump({'status': 'EXPORTED_PILOT_ONLY', 'formal_ready': False, 'stages': bindings,
                       'exporter_sha256': digest(Path(__file__).read_bytes())}, handle, indent=2)
    check(read(output / 'manifest.json') == manifest, 'output manifest differs from audited sources')
    for record, (spec, _) in zip(finals, exports):
        verify_asset(record, spec, output / Path(spec['asset']).name)
    print(json.dumps({'status': 'PASS', 'stages_audited': len(bindings), 'models_verified': len(finals),
                      'tensor_count': sum(len(r['state']) for r in finals), 'tensor_parity': 'exact',
                      'manifest': str(output / 'manifest.json'), 'formal_ready': False}))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
