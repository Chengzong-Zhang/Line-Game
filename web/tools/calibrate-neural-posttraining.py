"""Bounded tensor/serialization calibration; optimizer LR=0 preserves parent weights."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import statistics
import time

import numpy as np
import torch
from neural_posttraining_core import ROOT, available_models, build_model, distribution, make_batch, file_hash

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
torch.set_num_threads(1)
torch.set_num_interop_threads(1)
torch.use_deterministic_algorithms(True)
specs, _ = available_models()
representatives = [next(spec for spec in specs if spec.get("model_kind", spec.get("model_family")) == kind)
                   for kind in ("padded_cnn", "grid_gnn", "topology_gnn", "dqn", "ppo")]
rows = []
directory = args.output.resolve().parent
directory.mkdir(parents=True, exist_ok=True)
for spec in representatives:
    model = build_model(spec)
    parent = build_model(spec)
    for parameter in parent.parameters():
        parameter.requires_grad_(False)
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=0)
    for size in (5, 9, 15):
        positions = [(x, y) for y in range(size) for x in range(size - y)]
        indices = {point: i for i, point in enumerate(positions)}
        n = len(positions)
        features = np.zeros((n, 11), dtype=np.float32)
        features[:, 0] = 1
        for i, (x, y) in enumerate(positions):
            features[i, 5:8] = [x / (size - 1), y / (size - 1), int(x == 0 or y == 0 or x + y == size - 1)]
        physical = [[indices[p] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1))
                     if (p := (x + dx, y + dy)) in indices] for x, y in positions]
        mlp = np.zeros(842, dtype=np.float32)
        mlp[:n * 7] = features[:, :7].reshape(-1)
        mlp[840] = size / 15
        sample = {"features": features, "relations": [physical, [[] for _ in positions], [[] for _ in positions]],
                  "legal": list(range(n)), "target": np.full(n, 1 / n, dtype=np.float32), "modelFreeState": mlp}
        times = []
        for iteration in range(4):
            started = time.perf_counter()
            batch = make_batch([sample] * 16, "cpu")
            logp, target = distribution(model, spec, batch)
            with torch.no_grad():
                parent_logp, _ = distribution(parent, spec, batch)
            loss = -(target * logp).sum(dim=1).mean() + 0.1 * (parent_logp.exp() * (parent_logp - logp)).sum(dim=1).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
            if iteration:
                times.append(time.perf_counter() - started)
        rows.append({"family": spec.get("model_kind", spec.get("model_family")), "size": size,
                     "batch_size": 16, "median_step_seconds": statistics.median(times)})
    checkpoint = directory / f"calibration-{spec['id']}.pt"
    started = time.perf_counter()
    torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict()}, checkpoint)
    with checkpoint.open("r+b") as handle:
        os.fsync(handle.fileno())
    rows.append({"family": spec.get("model_kind", spec.get("model_family")), "checkpoint_bytes": checkpoint.stat().st_size,
                 "checkpoint_write_and_sync_seconds": time.perf_counter() - started})
worst = max(row.get("median_step_seconds", 0) for row in rows)
report = {
    "status": "PASS_BOUNDED_CPU_TENSOR_CALIBRATION", "device": "cpu", "threads": 1,
    "torch_version": str(torch.__version__), "rows": rows, "maximum_measured_step_seconds": worst,
    "1700_updates_at_slowest_measured_shape_seconds": 1700 * worst,
    "suggested_hard_budget_seconds": 1800, "full_training_started": False,
    "limits": ["Synthetic shape/density calibration, not trajectory or strength evidence.",
               "LR=0 preserved parent parameters; measured training-shaped forward/backward/Adam only.",
               "1700-step estimate excludes validation, repeated hashes, checkpoint I/O and system contention."],
    "calibrator_sha256": file_hash(Path(__file__)),
}
args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
