"""Bounded offline fine-tuning of a new candidate from reviewed Web features.

This is not an unattended training service or a strength gate. Each invocation
is limited to 100 updates / 60 seconds; durable per-update checkpoints support
strict same-run resume. Original pilot/F32 files are never modified.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import time

RESEARCH = Path(__file__).resolve().parents[1]
ROOT = RESEARCH.parents[1]
sys.path.insert(0, str(RESEARCH))
import torch
from lifeline_rl.alphazero.network import NetworkConfig, build_policy_value_network

def sha(raw): return hashlib.sha256(raw).hexdigest()
def read(path): return json.loads(Path(path).read_text(encoding="utf-8"))
def atomic(path, raw):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("wb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
def write_json(path, value): atomic(path, json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2).encode())

def load_dataset(directory):
    manifest = read(directory / "manifest.json"); raw = (directory / "samples.jsonl").read_bytes()
    if manifest.get("schema") != "lifeline-reviewed-web-training-v1" or manifest.get("rules_version") != "territory-v2" or sha(raw) != manifest["sample_sha256"]:
        raise ValueError("Dataset schema/hash mismatch")
    for name, digest in manifest["engine_sources"].items():
        if name not in {"GameEngine.js", "ReplayCodec.js", "ResearchAI.js"} or sha((ROOT / "web/web前端" / name).read_bytes()) != digest:
            raise ValueError("Web source hash mismatch")
    if set(manifest["engine_sources"]) != {"GameEngine.js", "ReplayCodec.js", "ResearchAI.js"}: raise ValueError("Incomplete Web source binding")
    rows = [json.loads(line) for line in raw.splitlines() if line]
    if len(rows) != manifest["samples"]: raise ValueError("Sample count mismatch")
    accepted = {d["game_id"]: d["split"] for d in manifest["decisions"] if d["accepted"]}
    for row in rows:
        n = row["board_size"]; nodes = n * (n + 1) // 2
        if type(n) is not int or not 5 <= n <= 15 or row["game_id"] not in accepted or row["split"] != accepted[row["game_id"]]: raise ValueError("Sample identity mismatch")
        if row["split"] != ("validation" if int(row["game_id"][:8], 16) % 5 == 0 else "train"): raise ValueError("Split identity mismatch")
        if len(row["features"]) != nodes * 11 or not all(type(x) in (int, float) and math.isfinite(x) for x in row["features"]): raise ValueError("Invalid features")
        if type(row["action"]) is not int or row["action"] not in row["legal"] or not row["legal"] or len(set(row["legal"])) != len(row["legal"]) or any(type(i) is not int or not 0 <= i <= nodes for i in row["legal"]): raise ValueError("Invalid mask/action")
        if len(row["relations"]) != 3 or any(len(rel) != nodes for rel in row["relations"]) or any(any(type(j) is not int or not 0 <= j < nodes for j in neighbors) for rel in row["relations"] for neighbors in rel): raise ValueError("Invalid relation indices")
        if row["value"] not in (-1, 0, 1) or row["policy_label"] != "reviewed_human_action" or row["value_label"] != "web_terminal_outcome": raise ValueError("Invalid target semantics")
    train = [r for r in rows if r["split"] == "train"]; validation = [r for r in rows if r["split"] == "validation"]
    if not train or not validation: raise ValueError("Require nonempty, disjoint whole-game training and validation sets")
    return manifest, train, validation

def inputs(row):
    nodes = row["board_size"] * (row["board_size"] + 1) // 2
    features = torch.tensor(row["features"], dtype=torch.float32).reshape(1, nodes, 11)
    adjacency = torch.zeros(1, 3, nodes, nodes)
    for relation, links in enumerate(row["relations"]):
        for node, neighbors in enumerate(links):
            if neighbors: adjacency[0, relation, node, neighbors] = 1 / len(neighbors)
    mask = torch.zeros(1, nodes + 1, dtype=torch.bool); mask[0, row["legal"]] = True
    return features, adjacency, torch.ones(1, nodes), mask

def train(args):
    if not 1 <= args.steps <= 100 or not 1 <= args.max_seconds <= 60 or not re.fullmatch(r"web-human-v1-[a-z0-9-]+", args.id): raise ValueError("Bounded budget / new candidate ID required")
    dataset_manifest, train_rows, validation = load_dataset(args.dataset)
    base_manifest = read(args.base_manifest); spec = next(s for s in base_manifest["models"] if s["id"] == args.base_id)
    base_file = args.base_manifest.parent / spec["asset"]
    # Some manifests use asset paths relative to the parent research-ai directory.
    if not base_file.exists(): base_file = args.base_manifest.parent.parent / spec["asset"]
    raw = base_file.read_bytes()
    if sha(raw) != spec["asset_sha256"] or len(raw) != spec["float_count"] * 4: raise ValueError("Base asset hash/size mismatch")
    torch.set_num_threads(1); torch.manual_seed(args.seed)
    model = build_policy_value_network(spec["model_kind"], NetworkConfig.from_dict(spec["network"]))
    expected = model.state_dict(); params = {}
    if list(expected) != [t["name"] for t in spec["tensors"]]: raise ValueError("Base parameter order mismatch")
    offset = 0
    for tensor in spec["tensors"]:
        if tensor["offset"] != offset or list(expected[tensor["name"]].shape) != tensor["shape"]: raise ValueError("Base tensor shape/order mismatch")
        values = struct.unpack_from("<" + str(tensor["length"]) + "f", raw, offset * 4)
        if not all(math.isfinite(x) for x in values): raise ValueError("Non-finite base weights")
        params[tensor["name"]] = torch.tensor(values).reshape(tensor["shape"]); offset += tensor["length"]
    if offset != spec["float_count"]: raise ValueError("Incomplete base tensor manifest")
    model.load_state_dict(params, strict=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-4)
    generator = torch.Generator().manual_seed(args.seed)
    sources = {"trainer": sha(Path(__file__).read_bytes()), "network": sha((RESEARCH / "lifeline_rl/alphazero/network.py").read_bytes())}
    identity = {"dataset_manifest_sha256": sha((args.dataset / "manifest.json").read_bytes()), "base_asset_sha256": sha(raw), "base_manifest_sha256": sha(args.base_manifest.read_bytes()), "sources": sources, "steps": args.steps, "seed": args.seed, "id": args.id, "smoke": args.smoke}
    if args.resume:
        if not args.output.is_dir(): raise ValueError("Resume directory missing")
    else: args.output.mkdir(parents=True, exist_ok=False)
    lock = args.output / "RUNNING.lock"
    with lock.open("x") as stream: stream.write(str(os.getpid()))
    try:
        step = 0
        if args.resume:
            latest = read(args.output / "latest.json"); checkpoint = args.output / latest["file"]
            if checkpoint.parent != args.output or sha(checkpoint.read_bytes()) != latest["sha256"]: raise ValueError("Checkpoint hash mismatch")
            state = torch.load(checkpoint, map_location="cpu", weights_only=True)
            if state["identity"] != identity: raise ValueError("Resume identity/source/config mismatch")
            model.load_state_dict(state["model"], strict=True); optimizer.load_state_dict(state["optimizer"])
            generator.set_state(state["sampler_rng"]); torch.set_rng_state(state["torch_rng"]); step = state["step"]
        def checkpoint():
            file = args.output / f"step-{step:04d}.pt"; temp = file.with_suffix(".pt.tmp")
            with temp.open("wb") as stream:
                torch.save({"identity": identity, "model": model.state_dict(), "optimizer": optimizer.state_dict(), "sampler_rng": generator.get_state(), "torch_rng": torch.get_rng_state(), "step": step}, stream)
                stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, file); write_json(args.output / "latest.json", {"file": file.name, "sha256": sha(file.read_bytes()), "step": step})
        if not args.resume: checkpoint()
        started = time.monotonic(); model.train()
        while step < args.steps:
            if time.monotonic() - started >= args.max_seconds:
                write_json(args.output / "status.json", {"status": "BUDGET_STOP", "step": step, "resume": True}); return 3
            row = train_rows[int(torch.randint(len(train_rows), (1,), generator=generator))]
            logits, value = model(*inputs(row)); policy_loss = torch.nn.functional.cross_entropy(logits, torch.tensor([row["action"]])); value_loss = (value - row["value"]).square().mean()
            loss = policy_loss + value_loss
            if not torch.isfinite(loss): raise ValueError("Non-finite training loss")
            optimizer.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); optimizer.step()
            if not all(bool(torch.isfinite(p).all()) for p in model.parameters()): raise ValueError("Non-finite parameters")
            step += 1; checkpoint()
            if args.stop_after_step and step == args.stop_after_step: return 7
        model.eval(); validation_losses = []
        with torch.no_grad():
            for row in validation[:64]:
                logits, value = model(*inputs(row)); validation_losses.append(float(torch.nn.functional.cross_entropy(logits, torch.tensor([row["action"]])) + (value - row["value"]).square().mean()))
        output_raw = b"".join(struct.pack("<" + str(t.numel()) + "f", *t.detach().contiguous().reshape(-1).tolist()) for t in model.state_dict().values())
        atomic(args.output / f"{args.id}.f32", output_raw)
        candidate = {**spec, "id": args.id, "label": args.id, "asset": f"{args.id}.f32", "asset_sha256": sha(output_raw),
            "evidence_tier": "smoke" if args.smoke else "pilot", "compatibility": "territory-v2 trial", "formal_ready": False,
            "seed": args.seed, "training_scheme": "reviewed_web_finetune_v1", "status": "SMOKE_ONLY" if args.smoke else "CANDIDATE_NOT_STRENGTH_VALIDATED",
            "stage": None, "stage_training_seed": None, "training_superko_mode": "enforce",
            "parent_checkpoint": spec.get("checkpoint"), "pretraining_board_sizes": spec["trained_board_sizes"],
            "checkpoint": {"file": f"step-{step:04d}.pt", "sha256": sha((args.output / f"step-{step:04d}.pt").read_bytes())},
            "fine_tuning_board_sizes": sorted({r["board_size"] for r in train_rows}), "parent_model_id": args.base_id,
            "web_training": {**identity, "train_games": dataset_manifest["train_games"], "validation_games": dataset_manifest["validation_games"], "validation_rows_evaluated": min(64, len(validation)), "validation_loss": sum(validation_losses) / len(validation_losses), "strength_evaluated": False}}
        write_json(args.output / "candidate-manifest.json", {"schema": base_manifest["schema"], "models": [candidate], "formal_ready": False})
        write_json(args.output / "status.json", {"status": "SMOKE_ONLY" if args.smoke else "CANDIDATE_NOT_STRENGTH_VALIDATED", "step": step, "formal_ready": False, "deployed": False, "asset_sha256": sha(output_raw)})
        print(json.dumps({"step": step, "id": args.id, "status": "SMOKE_ONLY" if args.smoke else "CANDIDATE_NOT_STRENGTH_VALIDATED", "formal_ready": False})); return 0
    finally: lock.unlink()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--dataset", type=Path, required=True); parser.add_argument("--base-manifest", type=Path, required=True); parser.add_argument("--base-id", required=True); parser.add_argument("--output", type=Path, required=True); parser.add_argument("--id", required=True)
    parser.add_argument("--steps", type=int, default=20); parser.add_argument("--max-seconds", type=int, default=60); parser.add_argument("--seed", type=int, default=20261013); parser.add_argument("--resume", action="store_true"); parser.add_argument("--smoke", action="store_true"); parser.add_argument("--stop-after-step", type=int, default=0)
    args = parser.parse_args(); args.dataset = args.dataset.resolve(); args.output = args.output.resolve(); args.base_manifest = args.base_manifest.resolve()
    return train(args)
if __name__ == "__main__": sys.exit(main())
