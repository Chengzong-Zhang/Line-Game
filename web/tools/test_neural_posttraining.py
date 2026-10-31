"""Bounded actual-worker recovery and original/exported Web numerical parity."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import torch

from neural_posttraining_core import (
    ROOT, ASSETS, available_models, build_model, distribution, file_hash,
    load_asset_state, load_dataset, make_batch,
)

torch.set_num_threads(1)
BASE = ROOT / "local_artifacts" / f"neural-posttraining-recovery-{time.time_ns()}"
DATA = BASE / "data"
SCRIPT = ROOT / "web/tools/posttrain-neural-models.py"
FIXTURE = ROOT / "web/web前端/tests/fixtures/neural-posttraining-fixture.mjs"
BASE.mkdir(parents=True)
subprocess.run(["node", str(FIXTURE), "--create", str(DATA)], cwd=ROOT, check=True)
CONFIG = BASE / "config.json"
config = json.loads((ROOT / "web/tools/configs/all-neural-distill-v1.json").read_text(encoding="utf-8"))
config.update(updates_per_model=3, batch_size=2, test_step_delay_ms=70)
CONFIG.write_text(json.dumps(config))
cases = []


def run(directory, *, kill=False, extra=()):
    command = [sys.executable, "-B", str(SCRIPT), "--run-root", str(directory), "--data-root", str(DATA),
               "--config", str(CONFIG), "--max-seconds", "60", *extra]
    worker = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    killed = False
    if kill:
        deadline = time.monotonic() + 30
        while worker.poll() is None and time.monotonic() < deadline:
            try:
                cp = json.loads((directory / "checkpoint.json").read_text(encoding="utf-8"))
                if cp.get("active", {}).get("step") == 1:
                    worker.kill()
                    killed = True
                    break
            except (OSError, ValueError, AttributeError):
                pass
            time.sleep(0.01)
        assert killed, "Must kill an actual worker after a committed optimizer step."
    output, _ = worker.communicate(timeout=90)
    return worker.returncode, output, killed


resumed, clean = BASE / "resumed", BASE / "clean"
code, output, killed = run(resumed, kill=True)
assert killed
interrupted = json.loads((resumed / "checkpoint.json").read_text(encoding="utf-8"))
assert interrupted["progress_units"] == 1
code, output, _ = run(resumed)
assert code == 0, output
code, output, _ = run(clean)
assert code == 0, output
resumed_manifest = json.loads((resumed / "candidate-manifest.json").read_text(encoding="utf-8"))
clean_manifest = json.loads((clean / "candidate-manifest.json").read_text(encoding="utf-8"))
assert resumed_manifest == clean_manifest, "Clean/resumed candidate manifests differ."
assert len(resumed_manifest["models"]) == 17
for spec in resumed_manifest["models"]:
    assert (resumed / spec["asset"]).read_bytes() == (clean / spec["asset"]).read_bytes()
resumed_checkpoint = json.loads((resumed / "checkpoint.json").read_text(encoding="utf-8"))
clean_checkpoint = json.loads((clean / "checkpoint.json").read_text(encoding="utf-8"))
for a, b in zip(resumed_checkpoint["completed"], clean_checkpoint["completed"], strict=True):
    sa = torch.load(resumed / a["state_path"], map_location="cpu", weights_only=False)
    sb = torch.load(clean / b["state_path"], map_location="cpu", weights_only=False)
    assert sa["step"] == sb["step"] == 3
    assert sa["python_rng"] == sb["python_rng"]
    assert torch.equal(sa["torch_rng"], sb["torch_rng"])
    for key in sa["model"]:
        assert torch.equal(sa["model"][key], sb["model"][key])
    for key, values in sa["optimizer"]["state"].items():
        for name, value in values.items():
            other = sb["optimizer"]["state"][key][name]
            assert torch.equal(value, other) if isinstance(value, torch.Tensor) else value == other
cases.append("actual-kill-step-checkpoint-full-17-model-exact-resume")
before = [(resumed / spec["asset"]).stat().st_mtime_ns for spec in resumed_manifest["models"]]
code, output, _ = run(resumed)
assert code == 0, output
assert before == [(resumed / spec["asset"]).stat().st_mtime_ns for spec in resumed_manifest["models"]]
cases.append("completed-models-not-rerun")

controls = BASE / "controls"
controls.mkdir()
for marker in ("PAUSE", "STOP"):
    (controls / marker).write_text("fixture")
    code, output, _ = run(controls)
    assert code == 75, output
    assert json.loads((controls / "progress.json").read_text(encoding="utf-8"))["status"] == ("PAUSED" if marker == "PAUSE" else "STOPPED")
    (controls / marker).unlink()
code, output, _ = run(controls, extra=("--max-new-units", "0"))
assert code == 75, output
cases.append("pause-stop-bounded-yield")
port = 40000 + int(hashlib.sha256(("neural-worker:" + str(controls.resolve()).lower()).encode()).hexdigest()[:8], 16) % 20000
guard = socket.socket()
if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
    guard.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
guard.bind(("127.0.0.1", port))
guard.listen(1)
before_progress = (controls / "progress.json").read_bytes()
try:
    code, output, _ = run(controls)
    assert code == 78 and "Duplicate worker" in output, output
    assert (controls / "progress.json").read_bytes() == before_progress
finally:
    guard.close()
cases.append("duplicate-OS-lease-rejected-without-overwriting-progress")

# Corrupt the actual completed bytes: complete-state revalidation must reject.
corrupted_asset = resumed / resumed_manifest["models"][0]["asset"]
original = corrupted_asset.read_bytes()
corrupted_asset.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
code, output, _ = run(resumed)
assert code == 78 and "corruption" in output, output
corrupted_asset.write_bytes(original)
CONFIG.write_text(json.dumps({**config, "learning_rate": 0.0002}))
code, output, _ = run(resumed)
assert code == 78 and "identity mismatch" in output, output
CONFIG.write_text(json.dumps(config))
cases.append("completed-corruption-and-config-drift-rejected")

# Compare original parents and trained exports to actual existing Web modules.
_, samples, _, _ = load_dataset(DATA)
episode = json.loads((DATA / "episodes/fixture-train.json").read_text(encoding="utf-8"))
sample = samples[2]
all_specs, _ = available_models()
probes = []
for parent_spec, candidate in zip(all_specs, clean_manifest["models"], strict=True):
    for spec, asset_path, suffix in ((parent_spec, ASSETS / parent_spec["asset"], "parent"),
                                     (candidate, clean / candidate["asset"], "candidate")):
        model = build_model(parent_spec)
        model.load_state_dict(load_asset_state(spec, asset_path))
        with torch.no_grad():
            logp, _ = distribution(model, parent_spec, make_batch([sample], "cpu"))
        probe_spec = copy.deepcopy(spec)
        probe_spec["asset"] = asset_path.name
        probes.append({
            "spec": probe_spec, "asset_path": str(asset_path), "size": sample["size"], "start": episode["start"],
            "actions": episode["actions"][:sample["ply"]], "legal": sample["legal"],
            "model_free_state": sample["modelFreeState"].tolist(),
            "probabilities": [float(logp[0, action].exp()) for action in sample["legal"]],
        })
probes_path = BASE / "parity-probes.json"
probes_path.write_text(json.dumps(probes))
parity = subprocess.run(["node", str(FIXTURE), "--parity", str(probes_path)], cwd=ROOT, capture_output=True, text=True, timeout=60)
assert parity.returncode == 0, parity.stdout + parity.stderr
parity_result = json.loads(parity.stdout)
cases.append("all-17-parents-and-17-exports-Web-PyTorch-parity")
report = {
    "status": "PASS_NEURAL_DISTILLATION_RECOVERY_AND_PARITY", "cases": cases,
    "fixture_models": 17, "fixture_updates_per_model": 3, "parity": parity_result,
    "source_hashes": {str(path.relative_to(ROOT)).replace("\\", "/"): file_hash(path)
                      for path in (SCRIPT, ROOT / "web/tools/neural_posttraining_core.py", Path(__file__), FIXTURE)},
    "artifact_directory": str(BASE), "full_training_started": False,
}
(BASE / "recovery-summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
