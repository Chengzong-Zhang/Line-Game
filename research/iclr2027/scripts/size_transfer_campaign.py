"""Sequential, resumable launcher for the three-family transfer_all pilot.

The campaign creates stage directories only when their parent stage has a
completed receipt.  Each stage is delegated to the transaction-level runner;
this script is the coarse stage supervisor and can itself be launched detached
from the current terminal.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
from typing import Any

import size_transfer_draft as draft
import size_transfer_runner as runner
from lifeline_rl.alphazero.config import AlphaZeroConfig


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / "research" / "iclr2027" / "results" / "pilot" / "size_transfer_v1_transfer_all_3families"
SEEDS = (2026092201, 2026092202, 2026092203)
FAMILIES = {
    "padded_cnn": {
        "plan": ROOT / "research" / "iclr2027" / "results" / "pilot" / "size_transfer_v1_plan_padded_cnn",
        "source": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.padded_cnn.seed20260825__ef12e34674a4" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "sha256": "934f12b8c2356afb1d630275135e8fd14893dc5b8b4b2e2ce8c98c4f9839bf15",
    },
    "grid_gnn": {
        "plan": ROOT / "research" / "iclr2027" / "results" / "pilot" / "size_transfer_v1_plan_grid_gnn",
        "source": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.grid_gnn.seed20260825__d0d5f17a2760" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "sha256": "0463c247ec42889fb30c5a23d4ed9b21c090495f2084a80d07b920edb8632a72",
    },
    "topology_gnn": {
        "plan": ROOT / "research" / "iclr2027" / "results" / "pilot" / "size_transfer_v1_plan_topology_gnn",
        "source": ROOT / "research" / "iclr2027" / "results" / "formal" / "d14_d16" / "run_v1" / "tasks" / "train.mixed_n5-7-9.topology_gnn.seed20260825__dd47afdb1e6c" / "training_run" / "snapshots" / "gradient_000200" / "checkpoint_000010.pt",
        "sha256": "7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207",
    },
}


def _append_event(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()


def _completed(run_directory: Path) -> bool:
    receipt = run_directory / "stage_receipt.json"
    if not receipt.is_file():
        return False
    try:
        data = json.loads(receipt.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RuntimeError(f"stage receipt is corrupt: {receipt}")
    return data.get("status") == "COMPLETE_NOT_FORMAL"


def _parent_source(run_directory: Path) -> tuple[Path, str]:
    if not _completed(run_directory):
        raise RuntimeError(f"parent stage is not complete: {run_directory}")
    manifest_path = run_directory / "checkpoints" / "latest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checkpoint = run_directory / "checkpoints" / manifest["checkpoint"]
    if not checkpoint.is_file():
        raise RuntimeError(f"parent checkpoint is missing: {checkpoint}")
    return checkpoint, manifest["sha256"]


def run_campaign(output_root: Path, *, device: str = "cpu") -> str:
    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    events = output_root / "campaign_events.jsonl"
    for family, spec in FAMILIES.items():
        if not spec["source"].is_file():
            raise RuntimeError(f"source checkpoint is missing: {spec['source']}")
        if draft.sha256_file(spec["source"]) != spec["sha256"]:
            raise RuntimeError(f"source checkpoint hash mismatch: {spec['source']}")
        parent: Path | None = None
        for seed in SEEDS:
            parent = None
            for stage in (1, 2, 3):
                if (output_root / "STOP").exists():
                    _append_event(events, {"time": time.time(), "status": "STOPPED", "family": family, "seed": seed, "stage": stage})
                    return "STOPPED"
                task_id = f"transfer_all.seed{seed}.stage{stage}"
                config_path = spec["plan"] / "configs" / f"{task_id}.json"
                config = AlphaZeroConfig.load(config_path)
                run_directory = output_root / family / task_id
                if not run_directory.exists():
                    if stage == 1:
                        source, source_sha = spec["source"], spec["sha256"]
                    else:
                        if parent is None:
                            raise RuntimeError("stage parent was not set")
                        source, source_sha = _parent_source(parent)
                    draft.initialize(config, run_directory, source=source, source_sha256=source_sha)
                    _append_event(events, {"time": time.time(), "status": "INITIALIZED", "family": family, "seed": seed, "stage": stage, "run": str(run_directory), "config_hash": config.fingerprint(), "source_sha256": source_sha})
                if _completed(run_directory):
                    status = "COMPLETE_NOT_FORMAL"
                else:
                    status = runner.supervise(run_directory, device=device)
                _append_event(events, {"time": time.time(), "status": status, "family": family, "seed": seed, "stage": stage, "run": str(run_directory)})
                if status != "COMPLETE_NOT_FORMAL":
                    return status
                parent = run_directory
    return "COMPLETE_NOT_FORMAL"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)
    status = run_campaign(args.output_root, device=args.device)
    print(json.dumps({"status": status, "output_root": str(args.output_root.resolve())}, ensure_ascii=False))
    return 0 if status == "COMPLETE_NOT_FORMAL" else 75


if __name__ == "__main__":
    raise SystemExit(main())
