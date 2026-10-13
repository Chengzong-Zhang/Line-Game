"""Reverify asset bytes and generate local Python parity / rule replay fixtures.

Fixtures are bounded engineering probes, never playing-strength evidence.
The Node companion reports rule differences separately from numerical parity.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import random
import torch
import export_web_size_transfer as export
from lifeline_rl import LifelineGame, Player
from lifeline_rl.alphazero.network import collate_positions

def state(game):
    return {'board': [int(x) for x in game.grid],
            'edges': {p.value: [list(e) for e in sorted(game.edges[p])] for p in Player},
            'currentPlayer': game.current_player.value, 'consecutiveSkips': game.consecutive_skips,
            'turnCount': game.turn_count, 'gameOver': game.game_over,
            'legal': sorted(game.point_to_index[p] for p in game.legal_moves()) if not game.game_over else [],
            'scores': {p.value: game.cached_territories[p].area for p in Player} if game.game_over else None,
            'winner': (game.winner().value if isinstance(game.winner(), Player) else game.winner()) if game.game_over else None}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    args = parser.parse_args()
    torch.set_num_threads(1)
    records, bindings = export.audit_campaign()
    manifest = export.read(export.OUTPUT / 'manifest.json')
    for record, spec in zip(records, manifest['models']):
        export.verify_asset(record, spec, export.OUTPUT / Path(spec['asset']).name)
    positions, replays = [], []
    for size in export.SIZES:
        for start in (Player.BLACK, Player.WHITE):
            game = LifelineGame(size, start_player=start, superko_mode='enforce')
            rng = random.Random(size * 100 + (start == Player.WHITE))
            steps = [{'action': 'initial', 'state': state(game)}]
            for ply in range(12):
                if game.game_over:
                    break
                moves = sorted(game.legal_moves())
                action = list(rng.choice(moves)) if moves else None
                result = game.skip_turn() if action is None else game.play_move(tuple(action))
                export.check(result.success, 'fixture move rejected')
                steps.append({'action': action, 'state': state(game)})
                if ply == 4 and not game.game_over:
                    predictions = {}
                    for record in records:
                        batch = collate_positions([game], record['config'].observation_mode)
                        # Inspect all point + PASS logits without confounding rule masks.
                        with torch.no_grad():
                            logits, value = record['model'](batch.node_features, batch.adjacency, batch.node_mask,
                                                           torch.ones_like(batch.legal_action_mask))
                        spec, _ = export.export_spec(record)
                        predictions[spec['id']] = {'logits': logits[0].tolist(), 'value': value.item()}
                    batches = {mode: collate_positions([game], mode) for mode in ('grid_graph', 'topology')}
                    positions.append({'size': size, 'start': start.value, 'state': state(game),
                                      'features': batches['topology'].node_features[0].tolist(),
                                      'relations': [[list(e) for e in game.physical_edges],
                                                    [list(e) for e in sorted(game.edges[game.current_player])],
                                                    [list(e) for e in sorted(game.edges[LifelineGame.opponent(game.current_player)])]],
                                      'predictions': predictions})
            for _ in range(2):
                if game.game_over:
                    break
                export.check(game.skip_turn().success, 'fixture pass rejected')
                steps.append({'action': None, 'state': state(game)})
            replays.append({'size': size, 'start': start.value, 'steps': steps})
    args.fixtures.parent.mkdir(parents=True, exist_ok=True)
    with args.fixtures.open('x', encoding='utf-8') as handle:
        json.dump({'status': 'PILOT_ONLY', 'source_hash': bindings[0]['source_hash'],
                   'models': [m['id'] for m in manifest['models']], 'positions': positions, 'replays': replays}, handle)
    print(json.dumps({'status': 'PASS', 'tensor_parity': 'exact', 'models': len(records),
                      'numeric_positions': len(positions), 'replay_prefixes': len(replays),
                      'fixtures_sha256': export.digest(args.fixtures.read_bytes()), 'formal_ready': False}))

if __name__ == '__main__':
    main()
