#!/usr/bin/env python3
"""Run the resumable discrete SAC baseline across side lengths 5--15."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))
import torch
from lifeline_rl.model_free.sac import SACConfig, SACTrainer

def main() -> int:
    p = argparse.ArgumentParser(); p.add_argument('--output-dir', type=Path, required=True); p.add_argument('--episodes', type=int, default=2000); p.add_argument('--board-sizes', default=','.join(str(n) for n in range(5,16))); p.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu'); p.add_argument('--smoke', action='store_true'); a=p.parse_args()
    try: sizes=tuple(sorted({int(x.strip()) for x in a.board_sizes.split(',') if x.strip()}))
    except ValueError as exc: p.error(f'invalid --board-sizes: {exc}')
    if not sizes or any(n not in range(5,16) for n in sizes): p.error('--board-sizes must contain side lengths in [5, 15]')
    c=SACConfig(board_sizes=(5,) if a.smoke else sizes, episodes=8 if a.smoke else a.episodes, max_plies=48 if a.smoke else 256, hidden_channels=64 if a.smoke else 512, replay_capacity=256 if a.smoke else 50000, batch_size=8 if a.smoke else 128, warmup_transitions=16 if a.smoke else 1000, updates_per_episode=1 if a.smoke else 4)
    t=SACTrainer(c,a.output_dir,device=a.device)
    for _ in range(c.episodes):
        m=t.run_episode()
        if t.episode % 100 == 0 or t.episode == c.episodes: t.save()
        print(json.dumps(m, sort_keys=True), flush=True)
    print(json.dumps({'status':'complete','episode':t.episode,'checkpoint':str(t.checkpoint_directory/'latest.json')}, sort_keys=True)); return 0
if __name__ == '__main__': raise SystemExit(main())
