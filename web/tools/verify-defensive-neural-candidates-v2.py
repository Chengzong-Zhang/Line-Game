"""Read-only candidate audit. Teacher agreement is not an arena/admission result."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys

import numpy as np
import torch

from defensive_neural_core_v2 import (
    ROOT, ASSETS, available_models, build_model, canonical, digest, distribution,
    export_bytes, file_hash, load_dataset, make_batch,
)
from neural_posttraining_core import load_asset_state


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sealed(path):
    body = json.loads(path.read_text(encoding="utf-8"))
    integrity = body.pop("integrity", None)
    require(integrity == digest(body), "Evidence seal mismatch: " + str(path))
    return body


def contained(root, relative):
    path = (root / relative).resolve()
    require(path.is_relative_to(root), "Evidence path leaves its run root")
    return path


def action_vectors(sample):
    scale = sample["size"] - 1
    positions = {(int(round(float(row[5]) * scale)), int(round(float(row[6]) * scale))): i
                 for i, row in enumerate(sample["features"])}
    result = {}
    for move in sample["sourceEvidence"]["label"]["moves"]:
        index = sample["nodeN"] if move["point"] is None else positions[tuple(move["point"])]
        result[index] = tuple(move["value"])
    require(set(result) == set(sample["legal"]), "Teacher vectors and encoded legality disagree")
    return result


def evaluate(model, spec, samples, batch_size=16, product_mask=False):
    model.eval(); records = []
    with torch.no_grad():
        for begin in range(0, len(samples), batch_size):
            selected = samples[begin:begin + batch_size]
            batch = make_batch(selected, "cpu")
            logp, targets = distribution(model, spec, batch)
            graph = "model_kind" in spec
            if graph:
                _, values = model(batch[0], batch[1], batch[2], batch[3])
            else:
                values = None
            for index, sample in enumerate(selected):
                n = sample["nodeN"]
                local_indices = list(range(n)) + [logp.shape[1] - 1] if graph else list(range(n + 1))
                local_logp = logp[index, local_indices].cpu().numpy().astype(np.float64)
                probabilities = np.exp(local_logp)
                require(np.isfinite(probabilities).all() and np.all(probabilities >= 0), "Nonfinite/negative policy probability")
                legal = list(sample["legal"])
                illegal = [x for x in range(n + 1) if x not in legal]
                require(not illegal or float(probabilities[illegal].sum()) <= 1e-8, "Policy puts probability on illegal actions")
                require(abs(float(probabilities.sum()) - 1) <= 2e-5, "Policy normalization failure")
                hidden_pass = bool(graph and not spec.get("action_contract", {}).get("pass") and any(x < n for x in legal))
                ce = float(-(sample["target"].astype(np.float64) * local_logp).sum())
                if product_mask and hidden_pass:
                    legal.remove(n)
                    visible = local_logp[legal]
                    log_total = float(np.max(visible) + np.log(np.exp(visible - np.max(visible)).sum()))
                    probabilities[:] = 0; probabilities[legal] = np.exp(visible - log_total)
                    ce = None if sample["target"][n] > 0 else float(-(sample["target"][legal] * (visible - log_total)).sum())
                predicted = max(legal, key=lambda action: probabilities[action])
                best = [action for action in sample["legal"] if sample["target"][action] > 0]
                vectors = action_vectors(sample)
                value = float(values[index]) if values is not None else None
                require(value is None or math.isfinite(value), "Nonfinite graph value prediction")
                records.append({"id": sample["id"], "split": sample["split"], "size": sample["size"],
                    "ce": ce,
                    "optimal": predicted in best, "optimal_mass": float(probabilities[best].sum()),
                    "pass_probability": float(probabilities[n]), "predicted_pass": predicted == n,
                    "predicted_action": predicted, "teacher_vector": vectors[predicted],
                    "teacher_best_vector": max(vectors.values()), "value": value,
                    "legacy_runtime_hides_pass": hidden_pass})
    return records


def summary(records):
    average = lambda key: float(np.mean([row[key] for row in records]))
    vectors = np.asarray([row["teacher_vector"] for row in records], dtype=np.float64)
    return {"positions": len(records), "full_action_ce": average("ce") if all(row["ce"] is not None for row in records) else None,
        "unrepresentable_teacher_target_positions": sum(row["ce"] is None for row in records),
        "teacher_optimal_action_agreement": average("optimal"), "teacher_optimal_probability_mass": average("optimal_mass"),
        "predicted_pass_rate": average("predicted_pass"), "mean_pass_probability": average("pass_probability"),
        "finite_horizon_defense_metrics": {"mean_own_nodes_lost": float(-vectors[:, 1].mean()),
            "mean_repeated_damaging_replies": float(-vectors[:, 2].mean()),
            "mean_own_coverage_lost": float(-vectors[:, 3].mean()),
            "mean_disconnected_own_nodes": float(-vectors[:, 4].mean()),
            "mean_root_connected_unbroken_cut_count": float(vectors[:, 5].mean())},
        "legacy_runtime_hidden_pass_positions": sum(row["legacy_runtime_hides_pass"] for row in records)}


def verify(run, data_root, config_path):
    cp = sealed(run / "checkpoint.json"); identity = sealed(run / "identity.json")
    manifest = sealed(run / "candidate-manifest.json"); receipt = sealed(run / "training-receipt.json")
    require(cp.get("schema") == "lifeline-defensive-neural-checkpoint-v2" and cp.get("status") == "COMPLETE" and cp.get("active") is None,
            "Neural run is not durably complete")
    require(digest(identity) == cp["identity"] == manifest["identity"] == receipt["identity"], "Candidate identity mismatch")
    require(manifest.get("schema") == "lifeline-defensive-neural-candidates-v2" and receipt.get("status") == "TRAINING_COMPLETE_NOT_STRENGTH_VERIFIED",
            "Unexpected candidate/receipt schema or status")
    require(manifest.get("strength_verified") is False and manifest.get("runtime_admitted") is False,
            "A fitting receipt cannot assert strength or runtime admission")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    require(file_hash(config_path) == identity["config_sha256"], "Frozen config hash mismatch")
    require(config.get("schema") == "lifeline-defensive-neural-config-v2", "Wrong config schema")
    for name, expected in identity["source_hashes"].items():
        require(file_hash(contained(ROOT, name)) == expected, "Frozen trainer source changed: " + name)
    for path, expected in identity["dataset_files"].items():
        require(file_hash(Path(path)) == expected, "Frozen dataset file changed")
    dataset, samples, dataset_files, _ = load_dataset(data_root)
    require(identity["dataset_identity"] == dataset["identity"] and identity["dataset_files"] == dataset_files, "Different defensive neural dataset")
    require(all(sample["sourceReceipt"]["search"]["maxReachedPly"] >= sample["sourceReceipt"]["search"]["requiredDepth"]
                for sample in samples), "This candidate audit requires actual source search to reach its complete reply horizon")
    specs, manifests = available_models(); by_id = {spec["id"]: spec for spec in specs}
    wanted = config.get("model_ids", list(by_id))
    selected = [spec["id"] for spec in specs if spec["id"] in wanted]
    require(identity["parent_manifest_hashes"] == manifests and selected == cp["model_order"], "Parent manifest/model selection changed")
    require(identity["parent_assets"] == {model_id: by_id[model_id]["asset_sha256"] for model_id in selected}, "Wrong parent assets")
    require([row["parent_model_id"] for row in cp["completed"]] == selected == [row["parent_model_id"] for row in manifest["models"]],
            "Incomplete/duplicate/out-of-order candidate closure")
    require(cp["progress_units"] == len(selected) * config["updates_per_model"] == receipt["updates"], "Completed update totals disagree")
    results = []
    validation = [sample for sample in samples if sample["split"] == "validation"]
    for record, candidate in zip(cp["completed"], manifest["models"]):
        parent_spec = by_id[record["parent_model_id"]]
        for path_key, hash_key in (("asset", "asset_sha256"), ("state_path", "state_sha256"), ("spec_path", "spec_sha256")):
            require(file_hash(contained(run, record[path_key])) == record[hash_key], "Completed candidate evidence changed")
        require(sealed(contained(run, record["spec_path"])) == candidate, "Candidate spec is not the committed spec bytes")
        require(candidate["asset_sha256"] == record["asset_sha256"] and candidate["asset"] == record["asset"], "Candidate asset mismatch")
        require(record["updates"] == config["updates_per_model"] and candidate.get("strength_verified") is False
                and candidate.get("runtime_admitted") is False, "Candidate fitting/admission contract mismatch")
        require(candidate["tensors"] == parent_spec["tensors"] and candidate["float_count"] == parent_spec["float_count"], "Changed parent tensor format")
        parent = build_model(parent_spec, "cpu"); model = build_model(parent_spec, "cpu")
        model.load_state_dict(load_asset_state(parent_spec, contained(run, record["asset"])), strict=True)
        require(export_bytes(model, parent_spec) == contained(run, record["asset"]).read_bytes(), "F32 export closure mismatch")
        frozen = [name for name in parent.state_dict() if name.startswith(("value_head.", "value."))]
        value_bytes = lambda tensor: tensor.detach().cpu().numpy().astype("<f4", copy=False).tobytes()
        require(all(value_bytes(parent.state_dict()[name]) == value_bytes(model.state_dict()[name]) for name in frozen), "Frozen value parameter bytes changed")
        parent_rows = evaluate(parent, parent_spec, validation)
        parent_product_rows = evaluate(parent, parent_spec, validation, product_mask=True)
        candidate_rows = evaluate(model, candidate, validation)
        product_rows = evaluate(model, candidate, validation, product_mask=True)
        better = sum(row["teacher_vector"] > base["teacher_vector"] for row, base in zip(candidate_rows, parent_rows))
        worse = sum(row["teacher_vector"] < base["teacher_vector"] for row, base in zip(candidate_rows, parent_rows))
        drift = [row["value"] - base["value"] for row, base in zip(candidate_rows, parent_rows) if row["value"] is not None]
        results.append({"parent_model_id": parent_spec["id"], "candidate_id": candidate["id"],
            "candidate_sha256": record["asset_sha256"], "parent_sha256": parent_spec["asset_sha256"],
            "asset_changed": record["asset_sha256"] != parent_spec["asset_sha256"],
            "frozen_value_tensor_count": len(frozen), "frozen_value_parameters_byte_equal": True,
            "parent": summary(parent_rows), "parent_current_product_mask": summary(parent_product_rows),
            "candidate": summary(candidate_rows), "candidate_current_product_mask": summary(product_rows),
            "predicted_teacher_vector_vs_parent": {"better": better, "same": len(validation) - better - worse, "worse": worse},
            "graph_value_prediction_drift": None if not drift else {"positions": len(drift), "mean_absolute": float(np.abs(drift).mean()),
                "max_absolute": float(np.abs(drift).max()), "mean_signed": float(np.mean(drift))},
            "active_pass_runtime_contract": bool("model_kind" not in candidate or candidate.get("action_contract", {}).get("pass"))})
    split_counts, coverage = {}, {}
    for sample in samples:
        key = f"{sample['size']}/{sample['split']}"; split_counts[key] = split_counts.get(key, 0) + 1
        state = sample["sourceEvidence"]["sourceState"]; search = sample["sourceReceipt"]["search"]
        cell = coverage.setdefault(key, {"positions": 0, "min_prefix_turns": state["turnCount"], "max_prefix_turns": state["turnCount"],
            "max_legal_placements": 0, "min_completed_depth": search["completedDepth"], "min_actual_reached_ply": search["maxReachedPly"]})
        cell["positions"] += 1; cell["min_prefix_turns"] = min(cell["min_prefix_turns"], state["turnCount"])
        cell["max_prefix_turns"] = max(cell["max_prefix_turns"], state["turnCount"])
        cell["max_legal_placements"] = max(cell["max_legal_placements"], len(sample["legal"]) - 1)
        cell["min_completed_depth"] = min(cell["min_completed_depth"], search["completedDepth"])
        cell["min_actual_reached_ply"] = min(cell["min_actual_reached_ply"], search["maxReachedPly"])
    return {"schema": "lifeline-defensive-neural-independent-verification-v2", "recordedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "COMPLETE_ARTIFACTS_VERIFIED_HELDOUT_TEACHER_ONLY", "training_identity": cp["identity"],
        "run_root": str(run), "data_root": str(data_root), "config_sha256": file_hash(config_path),
        "verifier_sha256": file_hash(Path(__file__)), "parent_manifest_hashes": manifests,
        "dataset_identity": dataset["identity"], "source_manifest_sha256": dataset["sourceManifestHash"],
        "models_verified": len(results), "updates_per_model": config["updates_per_model"], "split_counts": split_counts, "data_coverage": coverage,
        "finite_legal_normalized": True, "models": results, "strength_verified": False, "runtime_admitted": False,
        "limitations": ["Source subset is two-player triangle only; current plan selects crowded tactical positions with <=4 legal placements.",
            "Whole-game holdout is independent of fitting, but the same feasibility prefilter and late-state selection apply.",
            "Teacher vectors are finite-horizon paranoid-minimax counterfactual values, not realized match outcomes.",
            "Defense metrics attach exact teacher root vectors to raw policy argmax actions; they do not evaluate the candidate's subsequent policy or actual PUCT search.",
            "Frozen value parameters do not freeze value outputs when the shared backbone changes; no terminal-outcome calibration is established.",
            "Legacy graph manifests without action_contract.pass hide voluntary PASS under current ResearchAI runtime.",
            "No full-game arena, browser/native numerical parity, device acceptance, or product admission is claimed."]}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True); parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(); torch.set_num_threads(1)
    run, data_root = args.run_root.resolve(), args.data_root.resolve()
    result = verify(run, data_root, args.config.resolve())
    if args.output:
        output = args.output.resolve()
        require(not output.is_relative_to(run) and not output.is_relative_to(data_root), "Do not write into frozen training/data evidence")
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as handle: handle.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps({key: result[key] for key in ("status", "models_verified", "updates_per_model", "finite_legal_normalized", "strength_verified", "runtime_admitted")}))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"VERIFY_REJECTED: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(78)
