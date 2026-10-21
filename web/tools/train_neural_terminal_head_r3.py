"""New, frozen-backbone terminal-teacher experiment. Old runs remain immutable."""
from __future__ import annotations
import argparse, copy, io, json, random, socket, sys, time
from pathlib import Path
import torch
from neural_posttraining_core import ROOT, build_model, canonical, digest, distribution, export_bytes, file_hash, load_dataset, make_batch, sha, validation_loss
from posttrain_neural_models import atomic_bytes, atomic_json, sealed, FatalError

SOURCES = ["web/tools/train_neural_terminal_head_r3.py", "web/tools/posttrain-neural-models.py", "web/tools/neural_posttraining_core.py",
           "research/iclr2027/lifeline_rl/alphazero/network.py", "web/web前端/ResearchAI.js"]

def warm_specs(config):
    path = ROOT / config["warmstart_manifest"]
    assert file_hash(path) == config["warmstart_manifest_sha256"]
    source = json.loads(path.read_text(encoding="utf-8"))["models"]
    specs = []
    for wanted in config["model_ids"]:
        original = next(m for m in source if m["id"] == wanted)
        assert "model_kind" in original, "MLP dynamic PASS rows are intentionally excluded."
        spec = copy.deepcopy(original)
        spec["asset"] = str((path.parent / spec["asset"]).resolve())
        assert file_hash(Path(spec["asset"])) == spec["asset_sha256"]
        specs.append(spec)
    return specs

def head_model(spec):
    model = build_model(spec, "cpu")
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith("point_policy."))
    assert sum(p.numel() for p in model.parameters() if p.requires_grad) > 0
    return model

def immutable(path, raw):
    if path.exists():
        assert path.read_bytes() == raw, f"Existing committed bytes differ: {path}"
    else:
        atomic_bytes(path, raw)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run-root", required=True, type=Path); p.add_argument("--data-root", required=True, type=Path)
    p.add_argument("--config", required=True, type=Path); p.add_argument("--max-seconds", type=float, default=250)
    p.add_argument("--max-new-units", type=int, default=100000); p.add_argument("--fault", default="")
    args = p.parse_args(); run = args.run_root.resolve(); run.mkdir(parents=True, exist_ok=True)
    assert 0 < args.max_seconds <= 600 and args.max_new_units >= 0
    guard = socket.socket(); port = 40000 + int(sha(("terminal-head:" + str(run).lower()).encode())[:8], 16) % 20000
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"): guard.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try: guard.bind(("127.0.0.1", port)); guard.listen(1)
    except OSError: guard.close(); print("Duplicate head-only worker", file=sys.stderr); return 76
    cp = None; identity = None; started = time.monotonic(); fresh = 0
    def progress(status):
        atomic_json(run / "progress.json", {"identity": identity, "status": status, "progress_units": cp["units"], "stages": len(cp["stages"])})
    def control():
        for marker, status in (("STOP", "STOPPED"), ("PAUSE", "PAUSED")):
            if (run / marker).exists(): return status
        if time.monotonic() - started >= args.max_seconds or fresh >= args.max_new_units: return "YIELDED"
        return None
    try:
        c = json.loads(args.config.read_text(encoding="utf-8")); assert c["schema"] == "lifeline-neural-terminal-headonly-r3-v1"
        assert c["device"] == "cpu" and len(c["stage_updates"]) == len(c["learning_rates"]) == 3
        assert all(a < b for a, b in zip([0] + c["stage_updates"], c["stage_updates"]))
        assert not args.fault or c.get("recoveryTest")
        torch.set_num_threads(c["threads"]); torch.set_num_interop_threads(1); torch.use_deterministic_algorithms(True)
        specs = warm_specs(c); dataset, samples, data_files, _ = load_dataset(args.data_root)
        data_verification = json.loads((args.data_root / "verification.json").read_text(encoding="utf-8"))
        assert data_verification["status"] == "PASS_TERMINAL_ROLLOUT_DATA_R3"
        assert data_verification["manifest_sha256"] == file_hash(args.data_root / "manifest.json")
        train = [s for s in samples if s["split"] == "train"]; val = [s for s in samples if s["split"] == "validation"]
        bindings = {str((ROOT / s).resolve()): file_hash(ROOT / s) for s in SOURCES}
        bindings.update(data_files); bindings[str(args.config.resolve())] = file_hash(args.config)
        for path in [ROOT / c["warmstart_manifest"], args.data_root / "verification.json", *[Path(s["asset"]) for s in specs]]: bindings[str(path.resolve())] = file_hash(path)
        body = {"bindings": bindings, "config": c, "dataset_identity": dataset["identity"], "torch_version": str(torch.__version__)}
        identity = digest(body); cp_path = run / "checkpoint.json"
        cp = sealed(cp_path) if cp_path.exists() else {"identity": identity, "units": 0, "completed": [], "active": None, "stages": []}
        assert cp["identity"] == identity, "Source/config identity mismatch"
        for stage in cp["stages"]:
            for key in ("asset", "spec", "state"): assert file_hash(run / stage[key]) == stage[key + "_sha256"], "Committed stage corruption"
        signatures = {p: (Path(p).stat().st_size, Path(p).stat().st_mtime_ns) for p in bindings}
        def inputs():
            assert all((Path(p).stat().st_size, Path(p).stat().st_mtime_ns) == v for p, v in signatures.items()), "Frozen input changed"
        for tmp in run.glob("models/**/*.tmp-*"): tmp.rename(tmp.with_name("interrupted-" + tmp.name))
        atomic_json(run / "identity.json", body); atomic_json(cp_path, cp); progress("RUNNING")
        for spec in specs:
            if spec["id"] in cp["completed"]: continue
            seed = c["seed"] ^ int(sha(spec["id"].encode())[:8], 16); torch.manual_seed(seed); rng = random.Random(seed)
            model = head_model(spec); anchor = head_model(spec).eval()
            for parameter in anchor.parameters(): parameter.requires_grad_(False)
            optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=c["learning_rates"][0])
            step = 0; initial_ce = validation_loss(anchor, spec, val, "cpu")
            if cp["active"]:
                active = cp["active"]; assert active["id"] == spec["id"]
                path = run / active["path"]; assert file_hash(path) == active["sha256"]
                saved = torch.load(path, map_location="cpu", weights_only=False)
                assert saved["identity"] == identity and saved["id"] == spec["id"] and saved["step"] == active["step"]
                model.load_state_dict(saved["model"]); optimizer.load_state_dict(saved["optimizer"])
                rng.setstate(saved["rng"]); torch.set_rng_state(saved["torch_rng"]); step = saved["step"]
            directory = run / "models" / spec["parent_model_id"]; directory.mkdir(parents=True, exist_ok=True)
            while step < c["stage_updates"][-1]:
                status = control()
                if status: progress(status); return 75
                inputs(); stage_index = next(i for i, end in enumerate(c["stage_updates"]) if step < end)
                for group in optimizer.param_groups: group["lr"] = c["learning_rates"][stage_index]
                model.train(); batch = make_batch([train[rng.randrange(len(train))] for _ in range(c["batch_size"])], "cpu")
                logp, target = distribution(model, spec, batch)
                with torch.no_grad(): anchor_logp, _ = distribution(anchor, spec, batch)
                loss = -(target * logp).sum(1).mean() + c["parent_kl"] * (anchor_logp.exp() * (anchor_logp - logp)).sum(1).mean()
                assert torch.isfinite(loss); optimizer.zero_grad(set_to_none=True); loss.backward()
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], c["gradient_clip"]); optimizer.step(); step += 1
                assert all(torch.isfinite(p).all() for p in model.parameters())
                saved = {"identity": identity, "id": spec["id"], "step": step, "model": model.state_dict(), "optimizer": optimizer.state_dict(), "rng": rng.getstate(), "torch_rng": torch.get_rng_state()}
                stream = io.BytesIO(); torch.save(saved, stream); raw = stream.getvalue(); state_path = directory / f"step-{step:03d}.pt"
                immutable(state_path, raw)
                if args.fault == "after-state": return 91
                cp["active"] = {"id": spec["id"], "step": step, "path": str(state_path.relative_to(run)), "sha256": sha(raw)}
                cp["units"] += 1; fresh += 1; atomic_json(cp_path, cp); progress("RUNNING")
                if step in c["stage_updates"]:
                    for name, value in model.state_dict().items():
                        if not name.startswith("point_policy."): assert torch.equal(value, anchor.state_dict()[name]), "Frozen backbone/value/PASS drift"
                    candidate_id = spec["parent_model_id"] + f"-terminal-head-r3-s{step:03d}"
                    stage_dir = directory / f"stage-{step:03d}"; asset = stage_dir / (candidate_id + ".f32"); exported = export_bytes(model, spec); immutable(asset, exported)
                    candidate = copy.deepcopy(spec); candidate.update(id=candidate_id, asset=str(asset.relative_to(run)).replace("\\", "/"), asset_sha256=sha(exported),
                        label=spec["label"] + f" terminal head stage {step}", parent_model_id=spec["parent_model_id"], posttraining={
                         "method":"terminal-rollout teacher; point_policy only; frozen backbone/value/PASS", "warmstart_model_id":spec["id"],"warmstart_asset_sha256":spec["asset_sha256"],
                         "training_identity":identity,"dataset_identity":dataset["identity"],"updates":step,"optimizer_reset":True,"same_experiment_rl_resume":False,
                         "initial_validation_ce":initial_ce,"final_validation_ce":validation_loss(model,spec,val,"cpu"),"value_predictions_frozen":True,"pass_logits_frozen":True,
                         "pass_probability_frozen":False,"selection":"three fixed stages; separate new DEV must select","evidence_tier":"training-only; no strength claim"})
                    spec_path = stage_dir / "candidate.json"; immutable(spec_path, canonical(candidate) + b"\n")
                    item = {"id":candidate_id,"warmstart_id":spec["id"],"step":step,"asset":str(asset.relative_to(run)),"asset_sha256":sha(exported),"spec":str(spec_path.relative_to(run)),"spec_sha256":file_hash(spec_path),"state":str(state_path.relative_to(run)),"state_sha256":sha(raw)}
                    if not any(s["id"] == candidate_id for s in cp["stages"]): cp["stages"].append(item)
                    atomic_json(cp_path, cp)
                if c.get("test_delay_ms"): time.sleep(c["test_delay_ms"] / 1000)
            # Recover a process killed after the step checkpoint but before a
            # stage export by replaying stage emission in a separate pass below.
            cp["completed"].append(spec["id"]); cp["active"] = None; atomic_json(cp_path, cp)
        inputs(); assert len(cp["stages"]) == len(specs) * 3, "Missing stage export; fail closed"
        models = [json.loads((run / s["spec"]).read_text(encoding="utf-8")) for s in cp["stages"]]
        atomic_json(run / "candidate-manifest.json", {"schema":"lifeline-terminal-head-r3-candidates-v1","identity":identity,"models":models})
        for path, expected in bindings.items(): assert file_hash(Path(path)) == expected, "Final source/input drift"
        atomic_json(run / "training-receipt.json", {"status":"TRAINING_COMPLETE_NOT_STRENGTH_VERIFIED","identity":identity,"updates":cp["units"],"stages":cp["stages"],"model_count":len(specs),"train_samples":len(train),"validation_samples":len(val),"candidate_manifest_sha256":file_hash(run / "candidate-manifest.json")})
        progress("COMPLETE"); print(json.dumps({"status":"TRAINING_COMPLETE_NOT_STRENGTH_VERIFIED","updates":cp["units"],"stages":len(models)})); return 0
    except Exception as error:
        if cp: progress("FATAL")
        print(f"FATAL: {error}", file=sys.stderr); return 78
    finally: guard.close()

if __name__ == "__main__": raise SystemExit(main())
