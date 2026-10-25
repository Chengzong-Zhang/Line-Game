"""Small CPU-only recovery/encoding checks; never runs a production job."""
import argparse
import copy
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import torch
from defensive_neural_core_v2 import (
    ROOT, ASSETS, available_models, build_model, distribution, export_bytes,
    file_hash, load_dataset, make_batch, sha,
)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--recovery-device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args(); torch.set_num_threads(1)
    manifest, samples, _, _ = load_dataset(args.data_root)
    specs, _ = available_models()
    assert len(specs) == 17
    batch = make_batch(samples[:2], "cpu"); n = samples[0]["nodeN"]
    assert batch[3][:, -1].all() and batch[6][:, n].all() and not batch[6][:, 120].any()
    assert torch.allclose(batch[4].sum(1), torch.ones(2)) and torch.allclose(batch[7].sum(1), torch.ones(2))
    # Synthetic mixed-size tensor packaging only (not accepted as source data).
    larger = copy.deepcopy(samples[0]); larger.update(nodeN=21, size=6, features=np.zeros((21, 11), np.float32),
        relations=[[[] for _ in range(21)] for _ in range(3)], legal=[0, 21], target=np.zeros(22, np.float32))
    larger["target"][21] = 1
    mixed = make_batch([samples[0], larger], "cpu")
    assert mixed[3][0, 21] and not mixed[3][0, n] and mixed[3][1, 21]
    assert mixed[6][0, n] and mixed[6][1, 21] and mixed[7][1, 21] == 1
    checked = []
    for spec in specs:
        model = build_model(spec)
        assert export_bytes(model, spec) == (ASSETS / spec["asset"]).read_bytes()
        frozen = {name: p.detach().clone() for name, p in model.named_parameters() if name.startswith(("value_head.", "value."))}
        pass_name = "pass_policy.2.bias" if "model_kind" in spec else (
            "layers.4.bias" if spec["model_family"] == "dqn" else "head.bias" if spec["model_family"] == "sac" else "policy.bias")
        before = dict(model.named_parameters())[pass_name].detach().clone()
        opt = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=0.001)
        logp, target = distribution(model, spec, batch); loss = -(target * logp).sum(1).mean()
        assert torch.isfinite(loss); loss.backward(); opt.step()
        after = dict(model.named_parameters())[pass_name].detach()
        assert not torch.equal(before, after), spec["id"] + " PASS head did not update"
        for name, previous in frozen.items(): assert torch.equal(previous, dict(model.named_parameters())[name]), name
        assert len(export_bytes(model, spec)) == spec["float_count"] * 4
        checked.append(spec["id"])

    fixture = Path(tempfile.mkdtemp(prefix="lifeline-neural-recovery-v2-"))
    selected = [next(s["id"] for s in specs if s.get("model_kind") == "grid_gnn"), next(s["id"] for s in specs if s.get("model_family") == "dqn")]
    config = fixture / "config.json"
    body = dict(schema="lifeline-defensive-neural-config-v2", model_ids=selected, updates_per_model=2,
        batch_size=3, seed=7903, threads=1, device=args.recovery_device, learning_rate=0.0001, parent_kl=0.02, gradient_clip=2)
    config.write_text(json.dumps(body), encoding="utf-8")
    trainer = ROOT / "web/tools/train-defensive-neural-v2.py"
    def run(directory, extra=()):
        result = subprocess.run([sys.executable, str(trainer), "--data-root", str(args.data_root), "--config", str(config),
            "--run-root", str(directory), "--max-new-units", "100", "--max-seconds", "120", *extra],
            cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=150)
        return result
    resumed, clean = fixture / "resumed", fixture / "clean"
    first = run(resumed, ["--fault-after-checkpoint"]); assert first.returncode == 79, first.stderr
    cp = json.loads((resumed / "checkpoint.json").read_text(encoding="utf-8")); assert cp["progress_units"] == 1
    durable = resumed / cp["active"]["state_path"]; durable_hash = file_hash(durable)
    assert run(resumed).returncode == 0
    assert run(clean).returncode == 0
    a = json.loads((resumed / "candidate-manifest.json").read_text(encoding="utf-8")); b = json.loads((clean / "candidate-manifest.json").read_text(encoding="utf-8"))
    assert [x["asset_sha256"] for x in a["models"]] == [x["asset_sha256"] for x in b["models"]]
    assert file_hash(durable) == durable_hash
    for candidate in a["models"]: assert candidate["runtime_admitted"] is False and candidate["strength_verified"] is False
    cp_before = (resumed / "checkpoint.json").read_bytes()
    assert run(resumed).returncode == 0 and (resumed / "checkpoint.json").read_bytes() == cp_before
    paused = fixture / "paused"; paused.mkdir(); (paused / "PAUSE").write_text("")
    assert run(paused).returncode == 75
    assert json.loads((paused / "checkpoint.json").read_text(encoding="utf-8"))["progress_units"] == 0
    duplicate = fixture / "duplicate"; duplicate.mkdir()
    lease = socket.socket(); lease.bind(("127.0.0.1", 40000 + int(sha(("defensive-neural-v2-worker:" + str(duplicate.resolve()).lower()).encode())[:8], 16) % 20000)); lease.listen(1)
    try: assert run(duplicate).returncode == 78
    finally: lease.close()
    broken = json.loads((resumed / "checkpoint.json").read_text(encoding="utf-8")); broken["progress_units"] += 1
    (resumed / "checkpoint.json").write_text(json.dumps(broken))
    assert run(resumed).returncode == 78
    (resumed / "checkpoint.json").write_bytes(cp_before)
    body["learning_rate"] *= 2; config.write_text(json.dumps(body))
    assert run(resumed).returncode == 78
    for index, change in enumerate(({"model_ids": []}, {"learning_rate": float("nan")}, {"updates_per_model": True})):
        invalid = {**body, **change}; config.write_text(json.dumps(invalid), encoding="utf-8")
        assert run(fixture / f"invalid-{index}").returncode == 78
    print(json.dumps(dict(status="PASS_NEURAL_TINY_AND_RECOVERY", device=args.recovery_device, byte_exact_parents=checked,
        recovery_models=selected, optimizer_steps_per_model=2, fixtureRoot=str(fixture), trainedProductionModels=0)))


if __name__ == "__main__": main()
