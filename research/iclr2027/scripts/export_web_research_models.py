"""Export frozen D14--D16 policy/value checkpoints for browser inference.

The source checkpoints remain local research artifacts.  This script emits a
small inspectable manifest plus one little-endian F32 file per model; the F32
payloads are gitignored and must be published through an explicit asset
channel before a public deployment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import torch


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / "web" / "web前端" / "assets" / "research-ai"
SOURCE_HASH = "21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c"
MODELS = (
    {
        "id": "padded-cnn-d14-s20260825-g200",
        "label": "Padded-CNN + PUCT",
        "model_kind": "padded_cnn",
        "checkpoint": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.padded_cnn.seed20260825__ef12e34674a4" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "checkpoint_sha256": "934f12b8c2356afb1d630275135e8fd14893dc5b8b4b2e2ce8c98c4f9839bf15",
    },
    {
        "id": "grid-gnn-d14-s20260825-g200",
        "label": "Grid-GNN + PUCT",
        "model_kind": "grid_gnn",
        "checkpoint": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.grid_gnn.seed20260825__d0d5f17a2760" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "checkpoint_sha256": "0463c247ec42889fb30c5a23d4ed9b21c090495f2084a80d07b920edb8632a72",
    },
    {
        "id": "topology-gnn-d14-s20260825-g200",
        "label": "Topology-GNN + PUCT",
        "model_kind": "topology_gnn",
        "checkpoint": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.topology_gnn.seed20260825__dd47afdb1e6c" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "checkpoint_sha256": "7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207",
    },
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_model(spec: dict[str, Any], output: Path) -> dict[str, Any]:
    checkpoint = Path(spec["checkpoint"])
    if sha256_file(checkpoint) != spec["checkpoint_sha256"]:
        raise RuntimeError(f"checkpoint hash mismatch: {checkpoint}")
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    config = payload.get("config")
    metadata = payload.get("metadata")
    state_dict = payload.get("model_state_dict")
    if not isinstance(config, dict) or not isinstance(metadata, dict) or not isinstance(state_dict, dict):
        raise RuntimeError(f"checkpoint schema is incomplete: {checkpoint}")
    if config.get("model_kind") != spec["model_kind"] or metadata.get("model_kind") != spec["model_kind"]:
        raise RuntimeError(f"checkpoint model kind mismatch: {checkpoint}")
    if payload.get("source_hash") != SOURCE_HASH:
        raise RuntimeError(f"unexpected checkpoint source hash: {checkpoint}")

    target = output / f"{spec['id']}.f32"
    tensors: list[dict[str, Any]] = []
    offset = 0
    with target.open("wb") as handle:
        for name, value in state_dict.items():
            if not isinstance(value, torch.Tensor):
                raise RuntimeError(f"non-tensor model value {name!r}")
            tensor = value.detach().to(device="cpu", dtype=torch.float32).contiguous()
            raw = tensor.numpy().tobytes(order="C")
            handle.write(raw)
            tensors.append({"name": name, "shape": list(tensor.shape), "offset": offset, "length": tensor.numel()})
            offset += tensor.numel()

    return {
        "id": spec["id"],
        "label": spec["label"],
        "model_kind": spec["model_kind"],
        "observation_mode": config["observation_mode"],
        "trained_board_sizes": config["board_sizes"],
        "browser_inference": {
            "player_count": 2,
            "board_size_range": [5, 15],
            "evidence": "trained_board_sizes_only; other sizes are extrapolation trials",
        },
        "training_superko_mode": config["superko_mode"],
        "puct": {"simulations": config["puct_simulations"], "c_puct": config["c_puct"]},
        "network": {"hidden_channels": config["hidden_channels"], "message_passing_layers": config["message_passing_layers"]},
        "checkpoint": {"sha256": spec["checkpoint_sha256"], "config_hash": payload["config_hash"], "source_hash": payload["source_hash"]},
        "asset": target.name,
        "asset_sha256": sha256_file(target),
        "float_count": offset,
        "tensors": tensors,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": {"name": "lifeline-web-research-ai", "version": 1},
        "export_format": "little-endian-f32-state-dict",
        "rules_authority": "web/GameEngine.js",
        "compatibility": "territory-v2 trial; candidates are rechecked by the Web engine",
        "models": [export_model(spec, output) for spec in MODELS],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
