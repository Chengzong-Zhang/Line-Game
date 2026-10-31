"""Web-compatible policy distillation; never invokes the legacy RL trainers."""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "research" / "iclr2027"
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))
from lifeline_rl.alphazero.network import NetworkConfig, build_policy_value_network

MANIFESTS = ["manifest.json", "transfer-v1/manifest.json", "model-free-manifest.json"]
ASSETS = ROOT / "web" / "web前端" / "assets" / "research-ai"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(value) -> str:
    return sha(canonical(value))


def file_hash(path: Path) -> str:
    return sha(path.read_bytes())


def available_models():
    specs, manifest_hashes = [], {}
    for relative in MANIFESTS:
        path = ASSETS / relative
        manifest_hashes[str(path.relative_to(ROOT)).replace("\\", "/")] = file_hash(path)
        for original in json.loads(path.read_text(encoding="utf-8"))["models"]:
            spec = dict(original)
            spec["_manifest"] = relative
            asset = ASSETS / spec["asset"]
            if file_hash(asset) != spec["asset_sha256"]:
                raise ValueError(f"Parent asset hash mismatch: {spec['id']}")
            specs.append(spec)
    if len({spec["id"] for spec in specs}) != len(specs):
        raise ValueError("Duplicate model identity.")
    return specs, manifest_hashes


class WebMLP(nn.Module):
    """All current Web model-free bodies use ReLU, including PPO/GAIL/GAN."""
    def __init__(self, spec):
        super().__init__()
        self.family = spec["model_family"]
        hidden = spec["tensors"][0]["shape"][0]
        if self.family == "dqn":
            self.layers = nn.Sequential(nn.Linear(842, hidden), nn.ReLU(),
                                        nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, 121))
        else:
            self.body = nn.Sequential(nn.Linear(842, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU())
            if self.family in {"ppo", "gail", "gan"}:
                self.policy = nn.Linear(hidden, 121)
                self.value = nn.Linear(hidden, 1)
            else:
                self.head = nn.Linear(hidden, 121)

    def forward(self, states):
        if self.family == "dqn":
            return self.layers(states)
        hidden = self.body(states)
        return self.policy(hidden) if self.family in {"ppo", "gail", "gan"} else self.head(hidden)


def load_asset_state(spec, path=None):
    raw = (path or ASSETS / spec["asset"]).read_bytes()
    if len(raw) != spec["float_count"] * 4:
        raise ValueError("Parent F32 byte count mismatch.")
    values = np.frombuffer(raw, dtype="<f4").copy()
    if not np.isfinite(values).all():
        raise ValueError("Nonfinite parent weights.")
    state, offset = {}, 0
    for tensor in spec["tensors"]:
        if tensor["offset"] != offset or math.prod(tensor["shape"]) != tensor["length"]:
            raise ValueError("Invalid parent tensor manifest.")
        state[tensor["name"]] = torch.from_numpy(values[offset:offset + tensor["length"]].copy()).reshape(tensor["shape"])
        offset += tensor["length"]
    if offset != len(values):
        raise ValueError("Unaccounted parent weights.")
    return state


def build_model(spec, device="cpu"):
    if "model_kind" in spec:
        model = build_policy_value_network(spec["model_kind"], NetworkConfig(**spec["network"]))
    else:
        model = WebMLP(spec)
    model.load_state_dict(load_asset_state(spec), strict=True)
    # These heads are not supervised. A changed backbone can still change the
    # inherited value/pass predictions; final Web gameplay must evaluate that.
    for name, parameter in model.named_parameters():
        if name.startswith(("value_head.", "pass_policy.", "value.")):
            parameter.requires_grad_(False)
    return model.to(device)


def load_dataset(data_root):
    data_root = Path(data_root).resolve()
    manifest_path = data_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "lifeline-web-distillation-dataset-v1" or manifest.get("rulesVersion") != "territory-v2":
        raise ValueError("Unsupported Web distillation dataset.")
    if not isinstance(manifest.get("identity"), str) or not manifest["identity"]:
        raise ValueError("Missing dataset identity.")
    for relative, expected in manifest["source_hashes"].items():
        if file_hash(ROOT / relative) != expected:
            raise ValueError(f"Dataset source drift: {relative}")
    samples, files, counts, ids = [], {}, {}, set()
    for record in manifest["episodes"]:
        episode_path = (data_root / record["path"]).resolve()
        if not episode_path.is_relative_to(data_root) or record["id"] in ids:
            raise ValueError("Invalid/duplicate episode path or ID.")
        ids.add(record["id"])
        raw = episode_path.read_bytes()
        if sha(raw) != record["sha256"]:
            raise ValueError(f"Episode hash mismatch: {record['id']}")
        files[str(episode_path)] = sha(raw)
        episode = json.loads(raw)
        if episode["id"] != record["id"] or episode["split"] != record["split"] or episode["split"] not in {"train", "validation"}:
            raise ValueError("Whole-episode split mismatch.")
        if len(episode["samples"]) != record["samples"]:
            raise ValueError("Episode sample count mismatch.")
        for original in episode["samples"]:
            sample = dict(original)
            size = episode["size"]
            n = size * (size + 1) // 2
            if size != record["size"] or size not in range(5, 16):
                raise ValueError("Invalid sample board size.")
            features = np.asarray(sample["features"], dtype=np.float32)
            target = np.asarray(sample["target"], dtype=np.float32)
            mlp = np.asarray(sample["modelFreeState"], dtype=np.float32)
            legal = sample["legal"]
            if features.size != n * 11 or target.shape != (n,) or mlp.shape != (842,):
                raise ValueError("Invalid sample tensor shapes.")
            if not all(np.isfinite(value).all() for value in (features, target, mlp)):
                raise ValueError("Nonfinite dataset tensor.")
            if not legal or len(set(legal)) != len(legal) or any(type(x) is not int or x < 0 or x >= n for x in legal):
                raise ValueError("Invalid point-only legal mask.")
            if np.any(target < 0) or abs(float(target.sum()) - 1) > 1e-5 or any(target[x] != 0 for x in range(n) if x not in legal):
                raise ValueError("Invalid legal teacher distribution.")
            relations = sample["relations"]
            if len(relations) != 3 or any(len(relation) != n for relation in relations):
                raise ValueError("Invalid relation shape.")
            for relation in relations:
                for neighbors in relation:
                    if len(set(neighbors)) != len(neighbors) or any(type(x) is not int or x < 0 or x >= n for x in neighbors):
                        raise ValueError("Invalid adjacency index.")
            sample.update(size=size, features=features.reshape(n, 11), target=target, modelFreeState=mlp,
                          split=episode["split"], episode_id=episode["id"])
            samples.append(sample)
        key = f"{record['size']}/{record['split']}"
        counts[key] = counts.get(key, 0) + 1
    if not samples or not all(any(x["split"] == split for x in samples) for split in ("train", "validation")):
        raise ValueError("Empty training/validation split.")
    return manifest, samples, {str(manifest_path): file_hash(manifest_path), **files}, counts


def make_batch(samples, device):
    batch_size = len(samples)
    nodes = max(len(sample["target"]) for sample in samples)
    features = torch.zeros(batch_size, nodes, 11)
    adjacency = torch.zeros(batch_size, 3, nodes, nodes)
    node_mask = torch.zeros(batch_size, nodes, dtype=torch.bool)
    legal = torch.zeros(batch_size, nodes + 1, dtype=torch.bool)
    targets = torch.zeros(batch_size, nodes + 1)
    mlp = torch.zeros(batch_size, 842)
    mlp_legal = torch.zeros(batch_size, 121, dtype=torch.bool)
    mlp_targets = torch.zeros(batch_size, 121)
    for i, sample in enumerate(samples):
        n = len(sample["target"])
        features[i, :n] = torch.from_numpy(sample["features"])
        node_mask[i, :n] = True
        legal[i, sample["legal"]] = True
        targets[i, :n] = torch.from_numpy(sample["target"])
        mlp[i] = torch.from_numpy(sample["modelFreeState"])
        mlp_legal[i, sample["legal"]] = True
        mlp_targets[i, :n] = torch.from_numpy(sample["target"])
        for relation, rows in enumerate(sample["relations"]):
            for node, neighbors in enumerate(rows):
                if neighbors:
                    adjacency[i, relation, node, neighbors] = 1 / len(neighbors)
    return tuple(value.to(device) for value in (features, adjacency, node_mask, legal, targets, mlp, mlp_legal, mlp_targets))


def distribution(model, spec, batch):
    features, adjacency, node_mask, legal, targets, mlp, mlp_legal, mlp_targets = batch
    if "model_kind" in spec:
        logits, _ = model(features, adjacency, node_mask, legal)
    else:
        logits, legal, targets = model(mlp), mlp_legal, mlp_targets
    logits = logits.masked_fill(~legal, torch.finfo(logits.dtype).min)
    return torch.log_softmax(logits, dim=1), targets


def validation_loss(model, spec, samples, device, batch_size=16):
    model.eval()
    total = 0.0
    with torch.no_grad():
        for begin in range(0, len(samples), batch_size):
            selected = samples[begin:begin + batch_size]
            logp, target = distribution(model, spec, make_batch(selected, device))
            total += float(-(target * logp).sum(dim=1).sum())
    return total / len(samples)


def export_bytes(model, spec):
    state = model.state_dict()
    chunks = []
    for tensor in spec["tensors"]:
        value = state[tensor["name"]].detach().cpu().to(torch.float32).contiguous()
        if list(value.shape) != tensor["shape"] or not bool(torch.isfinite(value).all()):
            raise ValueError("Export tensor shape/finite failure.")
        chunks.append(value.numpy().astype("<f4", copy=False).tobytes())
    result = b"".join(chunks)
    if len(result) != spec["float_count"] * 4:
        raise ValueError("Export byte count mismatch.")
    return result
