"""PASS-aware warm-start adapter; reuses every deployed parent architecture/export."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import numpy as np
import torch

from neural_posttraining_core import (
    ROOT, ASSETS, available_models, build_model as parent_model, canonical, digest,
    distribution, export_bytes, file_hash, sha,
)


def build_model(spec, device="cpu"):
    model = parent_model(spec, device)
    # The old policy-only fitter froze PASS. Exact full-action labels supervise it.
    for name, parameter in model.named_parameters():
        if name.startswith("pass_policy."):
            parameter.requires_grad_(True)
        if name.startswith(("value_head.", "value.")):
            parameter.requires_grad_(False)
    if export_bytes(model, spec) != (ASSETS / spec["asset"]).read_bytes():
        raise ValueError("Warm-start is not byte-exact to the selected deployed parent")
    return model


def load_dataset(data_root):
    directory = Path(data_root).resolve()
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema") != "lifeline-defensive-neural-dataset-v2"
            or manifest.get("status") != "COMPLETE_DEFENSIVE_NEURAL_EXPORT"):
        raise ValueError("Only new complete defensive-neural exports are accepted")
    # Reconstruct all tensors from canonical rules/history and verify the full
    # source-bound >=3/two-opponent-round label contract at consumption time.
    verified = subprocess.run(["node", str(ROOT / "web/tools/export-defensive-neural-v2.mjs"),
                               "--data-root", manifest["sourceRoot"], "--output", str(directory), "--verify"],
                              capture_output=True, text=True, encoding="utf-8", timeout=300)
    if verified.returncode:
        raise ValueError("Source-bound defensive export verification failed: " + verified.stderr[-2500:])
    files = {str(manifest_path): file_hash(manifest_path)}
    source_root = Path(manifest["sourceRoot"]).resolve()
    source_manifest = source_root / "manifest.json"
    if file_hash(source_manifest) != manifest["sourceManifestHash"]:
        raise ValueError("Defensive source manifest changed")
    files[str(source_manifest)] = file_hash(source_manifest)
    source = json.loads(source_manifest.read_text(encoding="utf-8"))
    for record in source["samples"]:
        path = (source_root / record["path"]).resolve()
        if not path.is_relative_to(source_root) or file_hash(path) != record["sha256"]:
            raise ValueError("Defensive source sample changed")
        files[str(path)] = record["sha256"]
    samples, counts, ids = [], {}, set()
    for record in manifest["samples"]:
        path = (directory / record["path"]).resolve()
        if not path.is_relative_to(directory) or record["id"] in ids or file_hash(path) != record["sha256"]:
            raise ValueError("Invalid/duplicate/corrupt neural sample")
        ids.add(record["id"]); files[str(path)] = file_hash(path)
        sample = json.loads(path.read_text(encoding="utf-8")); sample.pop("integrity", None)
        n, size = sample["nodeN"], sample["size"]
        receipt = sample["sourceReceipt"]["search"]
        if (size not in range(5, 16) or n != size * (size + 1) // 2 or sample["passIndex"] != n
                or sample["rulesVersion"] not in {"territory-v2", "territory-v3"}
                or sample["split"] not in {"train", "validation"} or sample["split"] != record["split"]
                or sample["id"] != record["id"] or receipt["complete"] is not True
                or receipt["timedOut"] is not False or receipt["completedDepth"] < max(4, receipt["requiredDepth"])
                or receipt["completedDepth"] != receipt["requestedDepth"] or receipt["candidateCap"] is not None
                or receipt["allRootScoresExact"] is not True or receipt["includesPass"] is not True):
            raise ValueError("Invalid complete defensive neural sample receipt")
        features = np.asarray(sample["features"], dtype=np.float32)
        target = np.asarray(sample["target"], dtype=np.float32)
        mlp = np.asarray(sample["modelFreeState"], dtype=np.float32)
        legal = sample["legal"]
        if features.size != n * 11 or target.shape != (n + 1,) or mlp.shape != (842,):
            raise ValueError("Neural tensor shape mismatch")
        if not all(np.isfinite(x).all() for x in (features, target, mlp)):
            raise ValueError("Nonfinite neural tensors")
        if (len(set(legal)) != len(legal) or n not in legal
                or any(type(x) is not int or x < 0 or x > n for x in legal)
                or np.any(target < 0) or abs(float(target.sum()) - 1) > 1e-5
                or any(target[x] != 0 for x in range(n + 1) if x not in legal)):
            raise ValueError("Invalid full legal/PASS target")
        relations = sample["relations"]
        if len(relations) != 3 or any(len(rows) != n for rows in relations):
            raise ValueError("Neural relation shape mismatch")
        for rows in relations:
            for neighbors in rows:
                if len(set(neighbors)) != len(neighbors) or any(type(x) is not int or not 0 <= x < n for x in neighbors):
                    raise ValueError("Invalid neural adjacency")
        sample.update(features=features.reshape(n, 11), target=target, modelFreeState=mlp, episode_id=sample["id"])
        samples.append(sample)
        key = f"{size}/{sample['split']}"; counts[key] = counts.get(key, 0) + 1
    if not samples or not all(any(x["split"] == split for x in samples) for split in ("train", "validation")):
        raise ValueError("Independent training and validation samples required")
    return manifest, samples, files, counts


def make_batch(samples, device):
    batch_size = len(samples); nodes = max(sample["nodeN"] for sample in samples)
    features = torch.zeros(batch_size, nodes, 11)
    adjacency = torch.zeros(batch_size, 3, nodes, nodes)
    node_mask = torch.zeros(batch_size, nodes, dtype=torch.bool)
    legal = torch.zeros(batch_size, nodes + 1, dtype=torch.bool)
    targets = torch.zeros(batch_size, nodes + 1)
    mlp = torch.zeros(batch_size, 842)
    mlp_legal = torch.zeros(batch_size, 121, dtype=torch.bool)
    mlp_targets = torch.zeros(batch_size, 121)
    for i, sample in enumerate(samples):
        n = sample["nodeN"]
        features[i, :n] = torch.from_numpy(sample["features"])
        node_mask[i, :n] = True
        points = [index for index in sample["legal"] if index < n]
        legal[i, points] = True; legal[i, nodes] = True
        targets[i, :n] = torch.from_numpy(sample["target"][:n]); targets[i, nodes] = float(sample["target"][n])
        mlp[i] = torch.from_numpy(sample["modelFreeState"])
        # Browser ModelFreeAI encodes PASS at this sample's N, not fixed 120.
        mlp_legal[i, sample["legal"]] = True
        mlp_targets[i, :n + 1] = torch.from_numpy(sample["target"])
        for relation, rows in enumerate(sample["relations"]):
            for node, neighbors in enumerate(rows):
                if neighbors:
                    adjacency[i, relation, node, neighbors] = 1 / len(neighbors)
    return tuple(value.to(device) for value in (features, adjacency, node_mask, legal, targets, mlp, mlp_legal, mlp_targets))


def validation_loss(model, spec, samples, device, batch_size=16):
    model.eval(); total = 0.0
    with torch.no_grad():
        for begin in range(0, len(samples), batch_size):
            selected = samples[begin:begin + batch_size]
            logp, target = distribution(model, spec, make_batch(selected, device))
            total += float(-(target * logp).sum(dim=1).sum())
    return total / len(samples)
