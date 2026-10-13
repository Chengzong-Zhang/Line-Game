#!/usr/bin/env python3
"""Export trained model-free policy/Q weights to the browser F32 protocol."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import torch


MAX_POINTS = 15 * 16 // 2
ACTION_COUNT = MAX_POINTS + 1
STATE_DIMENSION = MAX_POINTS * 7 + 2


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def tensor_payload(state: dict[str, torch.Tensor], output: Path) -> tuple[list[dict[str, Any]], int]:
    tensors: list[dict[str, Any]] = []
    offset = 0
    with output.open("wb") as handle:
        for name, value in state.items():
            if not isinstance(value, torch.Tensor):
                continue
            tensor = value.detach().cpu().to(torch.float32).contiguous()
            raw = tensor.numpy().tobytes(order="C")
            handle.write(raw)
            tensors.append({"name": name, "shape": list(tensor.shape), "offset": offset, "length": tensor.numel()})
            offset += tensor.numel()
    return tensors, offset


def export_one(model_id: str, label: str, kind: str, checkpoint: Path, output: Path) -> dict[str, Any]:
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if kind == "dqn":
        state = {key.removeprefix("online."): value for key, value in payload["online"].items()}
        head = "q"
    elif kind == "ppo":
        state = dict(payload["model"])
        head = "policy"
    elif kind in {"sac", "gail", "gan"}:
        source = payload.get("policy") or payload.get("generator")
        if not isinstance(source, dict):
            raise RuntimeError(f"{checkpoint} does not contain a policy/generator state")
        state = dict(source)
        head = "policy"
    else:
        raise ValueError(kind)
    asset = output / f"{model_id}.f32"
    tensors, float_count = tensor_payload(state, asset)
    return {
        "id": model_id,
        "label": label,
        "model_family": kind,
        "browser_inference": {"player_count": 2, "board_size_range": [5, 15], "evidence": "trained_checkpoint"},
        "trained_board_sizes": list(range(5, 16)),
        "asset": asset.name,
        "asset_sha256": digest(asset),
        "checkpoint_sha256": digest(checkpoint),
        "float_count": float_count,
        "state_dimension": STATE_DIMENSION,
        "action_count": ACTION_COUNT,
        "head": head,
        "tensors": tensors,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    output = (args.output or root / "web" / "web前端" / "assets" / "research-ai").resolve()
    output.mkdir(parents=True, exist_ok=True)
    base = root / "local_artifacts" / "model_free"
    specs = [
        ("dqn-all-sizes-e2000", "DQN · 5–15", "dqn", base / "dqn_all_sizes_seed20260921_v1" / "checkpoints" / "episode_002000.pt"),
        ("ppo-all-sizes-e2000", "Maskable PPO · 5–15", "ppo", base / "ppo_all_sizes_seed20260921_v1" / "checkpoints" / "episode_002000.pt"),
        ("sac-all-sizes-e2000", "Discrete SAC · 5–15", "sac", base / "sac_all_sizes_seed20260921_v1" / "checkpoints" / "episode_002000.pt"),
        ("gail-all-sizes", "GAIL · greedy-expert adversarial policy", "gail", base / "imitation_all_sizes_seed20260921_v1" / "gail_all_sizes_seed20260921_v1" / "generator.pt"),
        ("gan-all-sizes", "Conditional GAN · greedy-expert policy", "gan", base / "imitation_all_sizes_seed20260921_v1" / "gan_all_sizes_seed20260921_v1" / "generator.pt"),
    ]
    manifest = {"schema": {"name": "lifeline-web-model-free", "version": 1}, "export_format": "little-endian-f32-state-dict", "models": [export_one(*spec, output) for spec in specs]}
    (output / "model-free-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
