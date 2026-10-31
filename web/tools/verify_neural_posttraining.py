"""Read-only independent checks of completed Web distillation candidates.

This does not retrain models or replay all optimizer updates. It re-evaluates
validation losses, checks saved optimizer/RNG state, and invokes actual Web code.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import time

import torch

from neural_posttraining_core import (
    ROOT, ASSETS, available_models, build_model, digest, file_hash,
    load_asset_state, load_dataset, make_batch, sha,
)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sealed(path):
    value = read(path)
    body = {key: item for key, item in value.items() if key != "integrity"}
    assert value.get("integrity") == digest(body), f"JSON integrity mismatch: {path}"
    return body


def contained(root, relative):
    path = (root / relative).resolve()
    assert path.is_relative_to(root), f"Path escapes evidence root: {relative}"
    return path


def close(actual, expected, label):
    assert math.isfinite(actual) and math.isfinite(expected)
    assert abs(actual - expected) <= 2e-6, f"{label}: {actual} != {expected}"


def point_log_probabilities(model, spec, batch):
    features, adjacency, node_mask, legal, target, mlp, mlp_legal, mlp_target = batch
    if "model_kind" in spec:
        logits, _ = model(features, adjacency, node_mask, legal)
    else:
        logits, legal, target = model(mlp), mlp_legal, mlp_target
    masked = torch.where(legal, logits, torch.full_like(logits, torch.finfo(logits.dtype).min))
    return torch.log_softmax(masked, dim=-1), target


def recompute_ce(model, spec, samples):
    model.eval()
    total = 0.0
    with torch.inference_mode():
        for begin in range(0, len(samples), 16):
            logp, target = point_log_probabilities(model, spec, make_batch(samples[begin:begin + 16], "cpu"))
            total += float(torch.sum(-target * logp))
    return total / len(samples)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    started = time.monotonic()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    run, data = args.run_root.resolve(), args.data_root.resolve()
    assert not args.output.resolve().is_relative_to(run), "Keep verification output outside frozen training evidence."
    config = read(args.config)
    identity = sealed(run / "identity.json")
    cp, progress = sealed(run / "checkpoint.json"), sealed(run / "progress.json")
    manifest, receipt = sealed(run / "candidate-manifest.json"), sealed(run / "training-receipt.json")
    training_identity = digest(identity)
    assert cp["status"] == progress["status"] == "COMPLETE"
    assert receipt["status"] == "TRAINING_COMPLETE_NOT_STRENGTH_VERIFIED"
    assert all(value["identity"] == training_identity for value in (cp, progress, manifest, receipt))
    assert cp["active"] is None
    assert identity["device"] == "cpu" and identity["torch_version"] == str(torch.__version__)
    assert identity["config_sha256"] == file_hash(args.config)
    assert receipt["candidate_manifest_sha256"] == file_hash(run / "candidate-manifest.json")
    for mapping in (identity["source_hashes"], identity["parent_manifest_hashes"]):
        for relative, expected in mapping.items():
            assert file_hash(ROOT / relative) == expected, relative
    specs, parent_manifests = available_models()
    if "model_ids" in config:
        specs = [spec for spec in specs if spec["id"] in config["model_ids"]]
    assert parent_manifests == identity["parent_manifest_hashes"]
    assert identity["parent_assets"] == {spec["id"]: spec["asset_sha256"] for spec in specs}
    dataset, samples, dataset_files, split_counts = load_dataset(data)
    data_verification = read(data / "verification.json")
    assert data_verification["status"] == "PASS_DATA_REPLAY"
    assert data_verification["manifest_sha256"] == file_hash(data / "manifest.json")
    assert dataset_files == identity["dataset_files"]
    assert dataset["identity"] == identity["dataset_identity"] == receipt["dataset_identity"]
    validation = [sample for sample in samples if sample["split"] == "validation"]
    training = [sample for sample in samples if sample["split"] == "train"]
    assert len(validation) == receipt["validation_samples"] == data_verification["validationSamples"]
    assert len(training) == receipt["training_samples"] == data_verification["trainSamples"]
    assert receipt["episode_split_counts"] == split_counts
    updates = config["updates_per_model"]
    order = [spec["id"] for spec in specs]
    assert cp["model_order"] == manifest["parent_model_order"] == order
    assert [model["parent_model_id"] for model in cp["completed"]] == order
    assert [model["parent_model_id"] for model in manifest["models"]] == order
    assert cp["completed"] == receipt["models"]
    assert cp["progress_units"] == receipt["updates"] == progress["progress_units"] == len(specs) * updates
    assert progress["completed_models"] == progress["total_models"] == len(specs)

    representatives = []
    for size in (5, 9, 15):
        pool = [sample for sample in validation if sample["size"] == size]
        assert pool, f"No parity sample for n={size}"
        # A fixed midgame sample; no model outcome influences this choice.
        representatives.append(pool[len(pool) // 3])
    episodes = {
        record["id"]: read(contained(data, record["path"]))
        for record in dataset["episodes"] if record["id"] in {s["episode_id"] for s in representatives}
    }
    probes, rows = [], []
    for spec, record, candidate in zip(specs, cp["completed"], manifest["models"], strict=True):
        assert record["updates"] == candidate["posttraining"]["updates"] == updates
        assert candidate["id"] == record["id"] == spec["id"] + "-distill-v1"
        assert candidate["posttraining"]["training_identity"] == training_identity
        assert candidate["posttraining"]["parent_asset_sha256"] == spec["asset_sha256"]
        for key, hash_key in (("asset", "asset_sha256"), ("state_path", "state_sha256"), ("spec_path", "spec_sha256")):
            assert file_hash(contained(run, record[key])) == record[hash_key], (spec["id"], key)
        assert candidate == sealed(contained(run, record["spec_path"]))
        assert candidate["asset"] == record["asset"] and candidate["asset_sha256"] == record["asset_sha256"]
        state = torch.load(contained(run, record["state_path"]), map_location="cpu", weights_only=False)
        assert state["identity"] == training_identity and state["model_id"] == spec["id"] and state["step"] == updates
        seed = config["seed"] ^ int(sha(spec["id"].encode())[:8], 16)
        torch.manual_seed(seed)
        model, parent = build_model(spec), build_model(spec)
        assert torch.equal(state["torch_rng"], torch.get_rng_state()), "Unexpected training Torch RNG progression."
        assert state["cuda_rng"] is None
        rng = random.Random(seed)
        for _ in range(updates * config["batch_size"]):
            rng.randrange(len(training))
        assert rng.getstate() == state["python_rng"], "Sampler RNG does not match committed update count."
        model.load_state_dict(state["model"], strict=True)
        exported = load_asset_state(spec, contained(run, record["asset"]))
        parent_state = parent.state_dict()
        frozen, changed, tensor_count = [], [], 0
        for name, tensor in state["model"].items():
            assert torch.isfinite(tensor).all(), (spec["id"], name)
            assert torch.equal(tensor, exported[name]), f"Export/state mismatch: {spec['id']}/{name}"
            tensor_count += 1
            if name.startswith(("value_head.", "pass_policy.", "value.")):
                assert torch.equal(tensor, parent_state[name]), f"Unsupervised head changed: {name}"
                frozen.append(name)
            elif not torch.equal(tensor, parent_state[name]):
                changed.append(name)
        assert changed, f"Candidate never changed from parent: {spec['id']}"
        trainable = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
        groups = state["optimizer"]["param_groups"]
        assert len(groups) == 1 and groups[0]["lr"] == config["learning_rate"]
        assert groups[0]["betas"] == (0.9, 0.999) and groups[0]["eps"] == 1e-8 and groups[0]["weight_decay"] == 0
        ids = groups[0]["params"]
        assert len(ids) == len(trainable) and len(set(ids)) == len(ids)
        assert set(ids) == set(state["optimizer"]["state"])
        for parameter_id, (name, parameter) in zip(ids, trainable, strict=True):
            adam = state["optimizer"]["state"][parameter_id]
            assert set(adam) == {"step", "exp_avg", "exp_avg_sq"}
            assert float(adam["step"]) == updates, (spec["id"], name)
            for key in ("exp_avg", "exp_avg_sq"):
                assert adam[key].shape == parameter.shape and torch.isfinite(adam[key]).all()
            assert torch.all(adam["exp_avg_sq"] >= 0)
        initial, final = recompute_ce(parent, spec, validation), recompute_ce(model, spec, validation)
        close(initial, state["initial_validation_loss"], "state initial CE")
        for source in (record, candidate["posttraining"]):
            close(initial, source["initial_validation_ce"], "receipt initial CE")
            close(final, source["final_validation_ce"], "receipt final CE")
        rows.append({
            "parent_model_id": spec["id"], "candidate_id": candidate["id"], "updates": updates,
            "initial_validation_ce": initial, "final_validation_ce": final, "ce_change": final - initial,
            "model_tensors_checked": tensor_count, "changed_tensors": len(changed),
            "frozen_head_tensors": len(frozen), "adam_parameters_checked": len(trainable),
            "model_free_dynamic_pass_row_may_change": "model_family" in spec,
            "asset_sha256": record["asset_sha256"], "state_sha256": record["state_sha256"],
            "python_rng_exact": True, "torch_rng_exact": True,
        })
        for network, model_spec, asset_path in (
            (parent, spec, ASSETS / spec["asset"]), (model, candidate, contained(run, candidate["asset"])),
        ):
            for sample in representatives:
                with torch.inference_mode():
                    logp, _ = point_log_probabilities(network, spec, make_batch([sample], "cpu"))
                episode = episodes[sample["episode_id"]]
                probe_spec = {key: copy.deepcopy(value) for key, value in model_spec.items() if not key.startswith("_")}
                probe_spec["asset"] = asset_path.name
                probes.append({
                    "spec": probe_spec, "asset_path": str(asset_path), "size": sample["size"],
                    "start": episode["start"], "actions": episode["actions"][:sample["ply"]],
                    "player": sample["player"], "legal": sample["legal"],
                    "probabilities": [float(logp[0, action].exp()) for action in sample["legal"]],
                })
        print(json.dumps({"verified_model": spec["id"], "updates": updates, "initial_ce": initial, "final_ce": final}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    probes_path = args.output.with_suffix(".parity-probes.json")
    probes_path.write_text(json.dumps(probes, ensure_ascii=False), encoding="utf-8")
    parity_script = ROOT / "web/tools/verify-neural-web-parity.mjs"
    parity = subprocess.run(["node", str(parity_script), str(probes_path)], cwd=ROOT,
                            capture_output=True, text=True, encoding="utf-8", timeout=300)
    assert parity.returncode == 0, parity.stdout + parity.stderr
    parity_report = json.loads(parity.stdout)
    report = {
        "status": "PASS_NEURAL_CANDIDATE_INTEGRITY_VALIDATION_AND_WEB_PARITY",
        "training_identity": training_identity, "models": len(rows), "updates_per_model": updates,
        "total_updates": len(rows) * updates, "training_samples": len(training),
        "validation_samples": len(validation), "posttraining_board_sizes": sorted({s["size"] for s in training}),
        "candidate_manifest_sha256": file_hash(run / "candidate-manifest.json"),
        "training_receipt_sha256": file_hash(run / "training-receipt.json"),
        "source_hashes": {
            str(path.relative_to(ROOT)).replace("\\", "/"): file_hash(path)
            for path in (Path(__file__).resolve(), parity_script, ROOT / "web/tools/neural_posttraining_core.py")
        },
        "verification_command": [sys.executable, "-B", str(Path(__file__).resolve()), *sys.argv[1:]],
        "elapsed_seconds": time.monotonic() - started, "web_parity": parity_report, "rows": rows,
        "limitations": [
            "Saved model/Adam/RNG state and losses are independently checked; 1700 optimizer updates are not replayed.",
            "Forward networks and batch construction reuse frozen training helpers; actual Web inference is a separate implementation.",
            "Validation CE measures teacher imitation, not playing strength or an independent statistical test.",
            "Model-free PPO/GAIL/GAN follow current Web ReLU semantics; original algorithm training is not resumed.",
            "Frozen value/PASS tensors do not imply frozen predictions when shared backbone tensors change.",
            "Model-free has a trainable shared action head; its Web PASS index n for smaller boards can be a supervised point row on larger boards.",
            "Inherited trained_board_sizes describes the parent; posttraining_board_sizes here records the current data.",
        ],
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "models": len(rows), "parity": parity_report,
                      "output": str(args.output), "elapsed_seconds": report["elapsed_seconds"]}))


if __name__ == "__main__":
    main()
