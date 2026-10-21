"""Bounded, step-checkpointed Web policy distillation from all existing F32 parents."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import random
import socket
import sys
import time
import uuid

import torch

from neural_posttraining_core import (
    ROOT, ASSETS, available_models, build_model, canonical, digest, distribution,
    export_bytes, file_hash, load_dataset, make_batch, sha, validation_loss,
)

SOURCES = [
    "web/tools/posttrain-neural-models.py", "web/tools/neural_posttraining_core.py",
    "research/iclr2027/lifeline_rl/alphazero/network.py",
    "web/web前端/ResearchAI.js", "web/web前端/ModelFreeAI.js",
]


class FatalError(Exception):
    pass


class ControlledExit(Exception):
    def __init__(self, status):
        self.status = status


def replace(source, destination):
    for attempt in range(8):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.015 * (attempt + 1))


def atomic_bytes(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    replace(temporary, path)


def atomic_json(path, body):
    body = {key: value for key, value in body.items() if key != "integrity"}
    atomic_bytes(path, canonical({**body, "integrity": digest(body)}) + b"\n")


def sealed(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    body = {key: item for key, item in value.items() if key != "integrity"}
    if value.get("integrity") != digest(body):
        raise FatalError(f"Corrupt JSON checkpoint: {path}")
    return body


def signature(path):
    info = path.stat()
    return info.st_size, info.st_mtime_ns


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=ROOT / "web/tools/configs/all-neural-distill-v1.json")
    parser.add_argument("--max-seconds", type=float, default=600)
    parser.add_argument("--max-new-units", type=int, default=100000)
    args = parser.parse_args()
    if args.max_seconds <= 0 or args.max_seconds > 3600 or args.max_new_units < 0:
        raise FatalError("Invalid invocation budget.")
    run = args.run_root.resolve()
    run.mkdir(parents=True, exist_ok=True)
    lease = socket.socket()
    port = 40000 + int(sha(("neural-worker:" + str(run).lower()).encode())[:8], 16) % 20000
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        lease.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        lease.bind(("127.0.0.1", port))
        lease.listen(1)
    except OSError as error:
        lease.close()
        raise FatalError(f"Duplicate worker or unavailable lease: {error}")
    started = time.monotonic()
    new_units = 0
    checkpoint = None
    identity = None
    checkpoint_path = run / "checkpoint.json"
    progress_path = run / "progress.json"

    def progress(status, message=None):
        atomic_json(progress_path, {
            "status": status, "identity": identity or "initializing", "progress_units": checkpoint["progress_units"] if checkpoint else 0,
            "completed_models": len(checkpoint["completed"]) if checkpoint else 0,
            "total_models": len(specs) if identity else 0,
            "active_model": checkpoint.get("active", {}).get("id") if checkpoint and checkpoint.get("active") else None,
            "active_step": checkpoint.get("active", {}).get("step", 0) if checkpoint and checkpoint.get("active") else 0,
            "message": message,
        })

    def control():
        if (run / "STOP").exists():
            raise ControlledExit("STOPPED")
        if (run / "PAUSE").exists():
            raise ControlledExit("PAUSED")
        if time.monotonic() - started >= args.max_seconds or new_units >= args.max_new_units:
            raise ControlledExit("YIELDED")

    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if config.get("schema") != "lifeline-web-neural-distillation-config-v1":
            raise FatalError("Unsupported training configuration.")
        for key in ("updates_per_model", "batch_size", "seed", "threads"):
            if not isinstance(config.get(key), int) or config[key] < 1:
                raise FatalError(f"Invalid {key}")
        if config["device"] not in {"cpu", "cuda"} or not (0 < config["learning_rate"] < 1) or config["parent_kl"] < 0 or config["gradient_clip"] <= 0:
            raise FatalError("Invalid optimizer/device configuration.")
        torch.set_num_threads(config["threads"])
        torch.set_num_interop_threads(1)
        torch.use_deterministic_algorithms(True)
        device = config["device"]
        if device == "cuda" and not torch.cuda.is_available():
            raise FatalError("Requested CUDA is unavailable.")
        all_specs, manifest_hashes = available_models()
        wanted = config.get("model_ids", [spec["id"] for spec in all_specs])
        specs = [spec for spec in all_specs if spec["id"] in wanted]
        if len(specs) != len(wanted) or len(set(wanted)) != len(wanted):
            raise FatalError("Unknown or duplicate model selection.")
        dataset, samples, dataset_files, split_counts = load_dataset(args.data_root)
        training = [sample for sample in samples if sample["split"] == "train"]
        validation = [sample for sample in samples if sample["split"] == "validation"]
        sources = {relative: file_hash(ROOT / relative) for relative in SOURCES}
        identity_body = {
            "source_hashes": sources, "config_sha256": file_hash(args.config),
            "dataset_identity": dataset["identity"], "dataset_files": dataset_files,
            "parent_manifest_hashes": manifest_hashes,
            "parent_assets": {spec["id"]: spec["asset_sha256"] for spec in specs},
            "torch_version": str(torch.__version__), "device": device,
        }
        identity = digest(identity_body)
        input_paths = [ROOT / relative for relative in sources] + [ROOT / relative for relative in manifest_hashes]
        input_paths += [ROOT / relative for relative in dataset["source_hashes"]]
        input_paths += [Path(path) for path in dataset_files] + [args.config.resolve()]
        input_paths += [ASSETS / spec["asset"] for spec in specs]
        input_signatures = {path: signature(path) for path in set(input_paths)}

        def check_inputs():
            if any(signature(path) != expected for path, expected in input_signatures.items()):
                raise FatalError("Frozen source/config/dataset/parent changed during training.")

        if checkpoint_path.exists():
            checkpoint = sealed(checkpoint_path)
            if checkpoint["identity"] != identity or checkpoint["model_order"] != [spec["id"] for spec in specs]:
                raise FatalError("Frozen identity mismatch; use a new run directory.")
        else:
            checkpoint = {
                "schema": "lifeline-neural-distillation-checkpoint-v1", "identity": identity,
                "model_order": [spec["id"] for spec in specs], "completed": [], "active": None,
                "progress_units": 0, "status": "RUNNING",
            }
            atomic_json(run / "identity.json", identity_body)
            atomic_json(checkpoint_path, checkpoint)
        if len({record["parent_model_id"] for record in checkpoint["completed"]}) != len(checkpoint["completed"]):
            raise FatalError("Duplicate completed models.")
        for record in checkpoint["completed"]:
            for key, hash_key in (("asset", "asset_sha256"), ("state_path", "state_sha256"), ("spec_path", "spec_sha256")):
                if file_hash(run / record[key]) != record[hash_key]:
                    raise FatalError("Completed model evidence corruption.")
        # Preserve incomplete writes from a killed worker rather than treating
        # them as valid checkpoints. No committed update is repeated.
        for temporary in run.glob("models/*/*.tmp-*"):
            interrupted = temporary.parent / ("interrupted-" + temporary.name)
            replace(temporary, interrupted)
        completed_ids = {record["parent_model_id"] for record in checkpoint["completed"]}
        progress("RUNNING")
        for spec in specs:
            if spec["id"] in completed_ids:
                continue
            control()
            check_inputs()
            model_seed = config["seed"] ^ int(sha(spec["id"].encode())[:8], 16)
            torch.manual_seed(model_seed)
            model = build_model(spec, device)
            parent = build_model(spec, device)
            parent.eval()
            for parameter in parent.parameters():
                parameter.requires_grad_(False)
            optimizer = torch.optim.Adam([parameter for parameter in model.parameters() if parameter.requires_grad],
                                         lr=config["learning_rate"])
            rng = random.Random(model_seed)
            directory = run / "models" / spec["id"]
            directory.mkdir(parents=True, exist_ok=True)
            active = checkpoint["active"]
            if active:
                if active["id"] != spec["id"]:
                    raise FatalError("In-flight model order mismatch.")
                state_path = run / active["state_path"]
                if file_hash(state_path) != active["state_sha256"]:
                    raise FatalError("Corrupt optimizer state bytes.")
                state = torch.load(state_path, map_location=device, weights_only=False)
                if state["identity"] != identity or state["model_id"] != spec["id"] or state["step"] != active["step"]:
                    raise FatalError("Corrupt optimizer state identity.")
                model.load_state_dict(state["model"])
                optimizer.load_state_dict(state["optimizer"])
                rng.setstate(state["python_rng"])
                torch.set_rng_state(state["torch_rng"].cpu())
                if device == "cuda":
                    torch.cuda.set_rng_state_all(state["cuda_rng"])
                initial_loss, step = state["initial_validation_loss"], state["step"]
            else:
                initial_loss = validation_loss(parent, spec, validation, device)
                step = 0
            while step < config["updates_per_model"]:
                control()
                check_inputs()
                model.train()
                selected = [training[rng.randrange(len(training))] for _ in range(config["batch_size"])]
                batch = make_batch(selected, device)
                logp, target = distribution(model, spec, batch)
                with torch.no_grad():
                    parent_logp, _ = distribution(parent, spec, batch)
                    parent_p = parent_logp.exp()
                ce = -(target * logp).sum(dim=1).mean()
                kl = (parent_p * (parent_logp - logp)).sum(dim=1).mean()
                objective = ce + config["parent_kl"] * kl
                if not bool(torch.isfinite(objective)):
                    raise FatalError("Nonfinite distillation loss.")
                optimizer.zero_grad(set_to_none=True)
                objective.backward()
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], config["gradient_clip"])
                optimizer.step()
                step += 1
                if any(not bool(torch.isfinite(p).all()) for p in model.parameters()):
                    raise FatalError("Nonfinite model state.")
                state = {
                    "identity": identity, "model_id": spec["id"], "step": step, "model": model.state_dict(),
                    "optimizer": optimizer.state_dict(), "python_rng": rng.getstate(),
                    "torch_rng": torch.get_rng_state(), "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else None,
                    "initial_validation_loss": initial_loss,
                }
                state_path = directory / f"step-{step:06d}-{uuid.uuid4().hex}.pt"
                temporary = state_path.with_name(state_path.name + ".tmp-" + uuid.uuid4().hex)
                torch.save(state, temporary)
                with temporary.open("r+b") as handle:
                    os.fsync(handle.fileno())
                replace(temporary, state_path)
                old_active = checkpoint["active"]
                checkpoint["active"] = {
                    "id": spec["id"], "step": step, "state_path": str(state_path.relative_to(run)),
                    "state_sha256": file_hash(state_path),
                    "previous_path": old_active["state_path"] if old_active else None,
                }
                checkpoint["progress_units"] += 1
                atomic_json(checkpoint_path, checkpoint)
                progress("RUNNING")
                new_units += 1
                # Only retire an internal state older than the two committed
                # snapshots; absolute containment is checked before deletion.
                if old_active and old_active.get("previous_path"):
                    retired = (run / old_active["previous_path"]).resolve()
                    if not retired.is_relative_to(directory.resolve()):
                        raise FatalError("Unsafe internal checkpoint retention path.")
                    retired.unlink(missing_ok=True)
                if config.get("test_step_delay_ms", 0):
                    time.sleep(config["test_step_delay_ms"] / 1000)
            final_loss = validation_loss(model, spec, validation, device)
            candidate = {key: copy.deepcopy(value) for key, value in spec.items() if not key.startswith("_")}
            candidate_id = spec["id"] + "-distill-v1"
            asset_path = directory / (candidate_id + ".f32")
            raw = export_bytes(model, spec)
            if asset_path.exists() and file_hash(asset_path) != sha(raw):
                raise FatalError("Existing candidate differs from deterministic export.")
            if not asset_path.exists():
                atomic_bytes(asset_path, raw)
            candidate.update(
                id=candidate_id, label=spec["label"] + " · supervised distillation candidate",
                parent_model_id=spec["id"], asset=str(asset_path.relative_to(run)).replace("\\", "/"),
                asset_sha256=sha(raw),
                posttraining={
                    "method": "Web-compatible supervised policy distillation",
                    "parent_model_id": spec["id"], "parent_asset_sha256": spec["asset_sha256"],
                    "parent_checkpoint_sha256": spec.get("checkpoint_sha256", spec.get("checkpoint", {}).get("sha256")),
                    "dataset_identity": dataset["identity"], "training_identity": identity,
                    "updates": step, "training_samples": len(training), "validation_samples": len(validation),
                    "initial_validation_ce": initial_loss, "final_validation_ce": final_loss,
                    "point_legal_only": True, "activation_contract": "current Web ReLU",
                    "optimizer_reset": True, "selection": "fixed final update; no test-based selection",
                    "value_head_frozen": True, "pass_head_frozen": True,
                    "evidence_tier": "application-distillation; independent arena pending",
                    "source_hashes": sources, "config_sha256": identity_body["config_sha256"],
                    "same_experiment_rl_resume": False,
                },
            )
            spec_path = directory / "candidate.json"
            atomic_json(spec_path, candidate)
            active = checkpoint["active"]
            checkpoint["completed"].append({
                "id": candidate_id, "parent_model_id": spec["id"], "asset": candidate["asset"],
                "asset_sha256": sha(raw), "spec_path": str(spec_path.relative_to(run)),
                "spec_sha256": file_hash(spec_path), "state_path": active["state_path"],
                "state_sha256": active["state_sha256"], "updates": step,
                "initial_validation_ce": initial_loss, "final_validation_ce": final_loss,
            })
            checkpoint["active"] = None
            atomic_json(checkpoint_path, checkpoint)
            progress("RUNNING")
            print(json.dumps({"completed_model": spec["id"], "updates": step, "initial_validation_ce": initial_loss,
                              "final_validation_ce": final_loss}), flush=True)
        check_inputs()
        candidate_specs = [sealed(run / item["spec_path"]) for item in checkpoint["completed"]]
        atomic_json(run / "candidate-manifest.json", {
            "schema": "lifeline-web-neural-distillation-candidates-v1", "identity": identity,
            "rulesVersion": "territory-v2", "models": candidate_specs, "parent_model_order": checkpoint["model_order"],
        })
        atomic_json(run / "training-receipt.json", {
            "status": "TRAINING_COMPLETE_NOT_STRENGTH_VERIFIED", "identity": identity,
            "method": "Web-compatible supervised policy distillation", "source_hashes": sources,
            "config_sha256": identity_body["config_sha256"], "dataset_identity": dataset["identity"],
            "models": checkpoint["completed"], "updates": checkpoint["progress_units"],
            "training_samples": len(training), "validation_samples": len(validation), "episode_split_counts": split_counts,
            "candidate_manifest_sha256": file_hash(run / "candidate-manifest.json"),
            "limitations": [
                "Weights-only warm-start with reset optimizer/RNG; not continuation of DQN/PPO/SAC/GAIL/GAN RL algorithms.",
                "PPO/GAIL/GAN use current browser ReLU semantics, not legacy Python ActorCritic Tanh.",
                "Value/pass head tensors stay frozen; shared backbone updates can change their predictions.",
                "No independent test result was used for selection; application strength is not established here.",
            ],
        })
        checkpoint["status"] = "COMPLETE"
        atomic_json(checkpoint_path, checkpoint)
        progress("COMPLETE")
        return 0
    except ControlledExit as error:
        progress(error.status)
        return 75
    except Exception as error:
        progress("FATAL", str(error))
        print(f"FATAL: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 78
    finally:
        lease.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FatalError as error:
        print(f"FATAL: {error}", file=sys.stderr)
        raise SystemExit(78)
