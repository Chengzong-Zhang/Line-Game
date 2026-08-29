"""Versioned, integrity-checked AlphaZero training checkpoints.

This module is intentionally not imported by :mod:`lifeline_rl`.  The reference
environment stays dependency free; importing this module explicitly requires
PyTorch.  Checkpoints are trusted local artifacts because ``torch.load`` uses
Python pickle internally.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import os
import random
import tempfile
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, MutableMapping, Sequence

try:
    import torch
except ImportError as exc:  # pragma: no cover - exercised in dependency-free installs
    raise ImportError(
        "lifeline_rl.alphazero.checkpoint requires PyTorch; install the "
        "AlphaZero training dependencies before importing this module"
    ) from exc


CHECKPOINT_SCHEMA_NAME = "lifeline-alphazero-checkpoint"
CHECKPOINT_SCHEMA_VERSION = 1
MANIFEST_SCHEMA_NAME = "lifeline-alphazero-latest"
MANIFEST_SCHEMA_VERSION = 1
LATEST_MANIFEST = "latest.json"


class CheckpointError(RuntimeError):
    """Base class for actionable checkpoint failures."""


class CheckpointIntegrityError(CheckpointError):
    """The checkpoint bytes do not match the recorded SHA-256 digest."""


class CheckpointSchemaError(CheckpointError):
    """A checkpoint or manifest has an unsupported or malformed schema."""


class CheckpointConfigError(CheckpointError):
    """The saved configuration is malformed or differs from the requested one."""


class CheckpointSourceError(CheckpointError):
    """The saved source identifier differs from the currently running source."""


def _normalise_json(value: Any, *, path: str = "config") -> Any:
    """Convert a configuration to a deterministic JSON-compatible value."""

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _normalise_json(dataclasses.asdict(value), path=path)
    if isinstance(value, Enum):
        return _normalise_json(value.value, path=path)
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, torch.device):
        return str(value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CheckpointConfigError(f"{path} contains a non-finite float")
        return value
    if isinstance(value, Mapping):
        normalised: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CheckpointConfigError(f"{path} has a non-string key: {key!r}")
            normalised[key] = _normalise_json(item, path=f"{path}.{key}")
        return normalised
    if isinstance(value, (list, tuple)):
        return [
            _normalise_json(item, path=f"{path}[{index}]")
            for index, item in enumerate(value)
        ]
    if isinstance(value, (set, frozenset)):
        items = [_normalise_json(item, path=f"{path}[]") for item in value]
        return sorted(
            items,
            key=lambda item: json.dumps(
                item, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            ),
        )
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _normalise_json(to_dict(), path=path)
    raise CheckpointConfigError(
        f"{path} contains unsupported value {value!r} ({type(value).__name__})"
    )


def canonical_config_json(config: Any) -> str:
    """Return the byte-stable JSON representation used for compatibility checks."""

    return json.dumps(
        _normalise_json(config),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def canonical_config_hash(config: Any) -> str:
    """Return the SHA-256 digest of :func:`canonical_config_json`."""

    return hashlib.sha256(canonical_config_json(config).encode("utf-8")).hexdigest()


def compute_source_hash(
    paths: Sequence[str | os.PathLike[str]],
    *,
    root: str | os.PathLike[str] | None = None,
) -> str:
    """Hash source paths and bytes deterministically relative to ``root``.

    Including relative path labels prevents two different file layouts with the
    same concatenated bytes from receiving the same identifier.
    """

    if not paths:
        raise CheckpointSourceError("at least one source file is required")
    base = Path.cwd().resolve() if root is None else Path(root).resolve()
    labelled: list[tuple[str, Path]] = []
    for raw_path in paths:
        candidate = Path(raw_path).resolve()
        if not candidate.is_file():
            raise CheckpointSourceError(f"source file does not exist: {candidate}")
        try:
            label = candidate.relative_to(base).as_posix()
        except ValueError as exc:
            raise CheckpointSourceError(
                f"source file {candidate} is outside hash root {base}"
            ) from exc
        labelled.append((label, candidate))
    digest = hashlib.sha256()
    for label, candidate in sorted(labelled):
        encoded_label = label.encode("utf-8")
        digest.update(len(encoded_label).to_bytes(8, "big"))
        digest.update(encoded_label)
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _numpy_or_none() -> Any | None:
    try:
        import numpy as np
    except ImportError:
        return None
    return np


def capture_global_rng_state() -> dict[str, Any]:
    """Capture process-global Python, NumPy, Torch CPU, and active CUDA RNGs."""

    np = _numpy_or_none()
    cuda_initialised = bool(torch.cuda.is_available() and torch.cuda.is_initialized())
    return {
        "python": random.getstate(),
        "numpy": None if np is None else np.random.get_state(),
        "torch_cpu": torch.get_rng_state(),
        "torch_cuda": (
            [state.cpu() for state in torch.cuda.get_rng_state_all()]
            if cuda_initialised
            else None
        ),
    }


def restore_global_rng_state(state: Mapping[str, Any]) -> None:
    """Restore every global RNG captured by :func:`capture_global_rng_state`."""

    required = {"python", "numpy", "torch_cpu", "torch_cuda"}
    missing = required.difference(state)
    if missing:
        raise CheckpointSchemaError(
            f"global RNG state is missing fields: {', '.join(sorted(missing))}"
        )
    try:
        random.setstate(state["python"])
    except (TypeError, ValueError) as exc:
        raise CheckpointSchemaError("invalid global Python RNG state") from exc

    numpy_state = state["numpy"]
    if numpy_state is not None:
        np = _numpy_or_none()
        if np is None:
            raise CheckpointError(
                "checkpoint contains NumPy RNG state but NumPy is unavailable"
            )
        try:
            np.random.set_state(numpy_state)
        except (TypeError, ValueError) as exc:
            raise CheckpointSchemaError("invalid global NumPy RNG state") from exc

    torch_state = state["torch_cpu"]
    if not torch.is_tensor(torch_state):
        raise CheckpointSchemaError("invalid Torch CPU RNG state")
    try:
        torch.set_rng_state(torch_state.detach().cpu())
    except RuntimeError as exc:
        raise CheckpointSchemaError("invalid Torch CPU RNG state") from exc

    cuda_states = state["torch_cuda"]
    if cuda_states is not None:
        if not torch.cuda.is_available():
            raise CheckpointError(
                "checkpoint contains CUDA RNG state but CUDA is unavailable; "
                "load with restore_global_rng=False for an intentional CPU migration"
            )
        if len(cuda_states) != torch.cuda.device_count():
            raise CheckpointError(
                "checkpoint CUDA RNG device count does not match this runtime"
            )
        try:
            torch.cuda.set_rng_state_all([item.detach().cpu() for item in cuda_states])
        except (AttributeError, RuntimeError) as exc:
            raise CheckpointSchemaError("invalid Torch CUDA RNG state") from exc


def capture_local_rng_states(local_rngs: Mapping[str, Any] | None) -> dict[str, Any]:
    """Capture named trainer-local Python, NumPy, Torch, or getstate RNGs."""

    if local_rngs is None:
        return {}
    np = _numpy_or_none()
    captured: dict[str, Any] = {}
    for name, rng in local_rngs.items():
        if not isinstance(name, str) or not name:
            raise CheckpointError("local RNG names must be non-empty strings")
        if isinstance(rng, random.Random):
            captured[name] = {"kind": "python", "state": rng.getstate()}
        elif isinstance(rng, torch.Generator):
            captured[name] = {
                "kind": "torch",
                "device": str(rng.device),
                "state": rng.get_state().cpu(),
            }
        elif np is not None and isinstance(rng, np.random.Generator):
            captured[name] = {
                "kind": "numpy_generator",
                "bit_generator": rng.bit_generator.__class__.__name__,
                "state": rng.bit_generator.state,
            }
        elif np is not None and isinstance(rng, np.random.RandomState):
            captured[name] = {"kind": "numpy_random_state", "state": rng.get_state()}
        elif callable(getattr(rng, "getstate", None)):
            captured[name] = {"kind": "getstate", "state": rng.getstate()}
        else:
            raise CheckpointError(
                f"unsupported local RNG {name!r}: {type(rng).__name__}"
            )
    return captured


def restore_local_rng_states(
    local_rngs: Mapping[str, Any],
    saved_states: Mapping[str, Any],
) -> None:
    """Restore named local RNG objects, rejecting missing or incompatible ones."""

    np = _numpy_or_none()
    missing = set(saved_states).difference(local_rngs)
    if missing:
        raise CheckpointError(
            f"local RNG objects are missing: {', '.join(sorted(missing))}"
        )
    for name, entry in saved_states.items():
        if not isinstance(entry, Mapping) or "kind" not in entry or "state" not in entry:
            raise CheckpointSchemaError(f"invalid saved local RNG entry {name!r}")
        rng = local_rngs[name]
        kind = entry["kind"]
        try:
            if kind == "python" and isinstance(rng, random.Random):
                rng.setstate(entry["state"])
            elif kind == "torch" and isinstance(rng, torch.Generator):
                saved_device = str(entry.get("device", "cpu"))
                if str(rng.device) != saved_device:
                    raise CheckpointError(
                        f"local Torch RNG {name!r} device mismatch: "
                        f"saved {saved_device}, current {rng.device}"
                    )
                rng.set_state(entry["state"].detach().cpu())
            elif (
                kind == "numpy_generator"
                and np is not None
                and isinstance(rng, np.random.Generator)
            ):
                if rng.bit_generator.__class__.__name__ != entry.get("bit_generator"):
                    raise CheckpointError(
                        f"local NumPy RNG {name!r} uses a different bit generator"
                    )
                rng.bit_generator.state = entry["state"]
            elif (
                kind == "numpy_random_state"
                and np is not None
                and isinstance(rng, np.random.RandomState)
            ):
                rng.set_state(entry["state"])
            elif kind == "getstate" and callable(getattr(rng, "setstate", None)):
                rng.setstate(entry["state"])
            else:
                raise CheckpointError(
                    f"local RNG {name!r} is incompatible with saved kind {kind!r}"
                )
        except CheckpointError:
            raise
        except (AttributeError, RuntimeError, TypeError, ValueError) as exc:
            raise CheckpointSchemaError(f"invalid state for local RNG {name!r}") from exc


def _state_dict(component: Any | None, name: str) -> Any | None:
    if component is None:
        return None
    method = getattr(component, "state_dict", None)
    if not callable(method):
        raise CheckpointError(f"{name} must provide state_dict()")
    try:
        return method()
    except Exception as exc:
        raise CheckpointError(f"failed to capture {name} state") from exc


def _load_state_dict(component: Any | None, state: Any, name: str, **kwargs: Any) -> None:
    if component is None:
        return
    if state is None:
        raise CheckpointSchemaError(f"checkpoint does not contain {name} state")
    method = getattr(component, "load_state_dict", None)
    if not callable(method):
        raise CheckpointError(f"{name} must provide load_state_dict()")
    try:
        method(state, **kwargs)
    except TypeError as first_error:
        if not kwargs:
            raise CheckpointError(f"failed to restore {name} state") from first_error
        # Non-Torch stateful helpers may not accept ``strict``.  Retry once
        # without optional keywords while still wrapping any actionable error.
        try:
            method(state)
        except Exception as exc:
            raise CheckpointError(f"failed to restore {name} state") from exc
    except Exception as exc:
        raise CheckpointError(f"failed to restore {name} state") from exc


def _validate_counters(counters: Mapping[str, int] | None) -> dict[str, int]:
    if counters is None:
        return {}
    result: dict[str, int] = {}
    for key, value in counters.items():
        if not isinstance(key, str) or not key:
            raise CheckpointError("counter names must be non-empty strings")
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise CheckpointError(f"counter {key!r} must be a non-negative integer")
        result[key] = value
    return result


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_torch_save(payload: Mapping[str, Any], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        torch.save(dict(payload), temporary)
        # Windows rejects ``fsync`` on some read-only descriptors.  Reopen the
        # completed archive read/write solely for the durability barrier.
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _atomic_json_save(payload: Mapping[str, Any], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def save_checkpoint(
    path: str | os.PathLike[str],
    *,
    model: Any,
    config: Any,
    source_hash: str,
    optimizer: Any | None = None,
    scheduler: Any | None = None,
    scaler: Any | None = None,
    buffer: Any | None = None,
    trainer_state: Mapping[str, Any] | None = None,
    counters: Mapping[str, int] | None = None,
    local_rngs: Mapping[str, Any] | None = None,
    metadata: Mapping[str, Any] | None = None,
    overwrite: bool = True,
) -> dict[str, Any]:
    """Atomically write one checkpoint and replace its sibling ``latest.json``."""

    destination = Path(path)
    if destination.name == LATEST_MANIFEST:
        raise CheckpointError(f"checkpoint path cannot be named {LATEST_MANIFEST}")
    if destination.exists() and not overwrite:
        raise CheckpointError(f"checkpoint already exists: {destination}")
    if not isinstance(source_hash, str) or not source_hash.strip():
        raise CheckpointSourceError("source_hash must be a non-empty string")

    config_json = canonical_config_json(config)
    config_value = json.loads(config_json)
    config_digest = hashlib.sha256(config_json.encode("utf-8")).hexdigest()
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload: dict[str, Any] = {
        "schema": {
            "name": CHECKPOINT_SCHEMA_NAME,
            "version": CHECKPOINT_SCHEMA_VERSION,
        },
        "created_at_utc": created_at,
        "config": config_value,
        "config_json": config_json,
        "config_hash": config_digest,
        "source_hash": source_hash.strip(),
        "model_state_dict": _state_dict(model, "model"),
        "optimizer_state_dict": _state_dict(optimizer, "optimizer"),
        "scheduler_state_dict": _state_dict(scheduler, "scheduler"),
        "scaler_state_dict": _state_dict(scaler, "scaler"),
        "buffer_state_dict": _state_dict(buffer, "buffer"),
        "trainer_state": dict(trainer_state or {}),
        "counters": _validate_counters(counters),
        "local_rng_state": capture_local_rng_states(local_rngs),
        "global_rng_state": capture_global_rng_state(),
        "metadata": dict(metadata or {}),
    }
    try:
        _atomic_torch_save(payload, destination)
    except Exception as exc:
        if isinstance(exc, CheckpointError):
            raise
        raise CheckpointError(f"failed to atomically save checkpoint {destination}") from exc

    manifest: dict[str, Any] = {
        "schema": {
            "name": MANIFEST_SCHEMA_NAME,
            "version": MANIFEST_SCHEMA_VERSION,
        },
        "checkpoint": destination.name,
        "checkpoint_schema_version": CHECKPOINT_SCHEMA_VERSION,
        "sha256": _sha256_file(destination),
        "size_bytes": destination.stat().st_size,
        "created_at_utc": created_at,
        "config_hash": config_digest,
        "source_hash": source_hash.strip(),
    }
    try:
        _atomic_json_save(manifest, destination.parent / LATEST_MANIFEST)
    except Exception as exc:
        raise CheckpointError(
            f"checkpoint was written but latest manifest update failed: {destination}"
        ) from exc
    return manifest


def _read_latest_manifest(path: Path) -> tuple[Path, dict[str, Any]]:
    if path.is_dir():
        manifest_path = path / LATEST_MANIFEST
        explicit_checkpoint: Path | None = None
    elif path.name == LATEST_MANIFEST:
        manifest_path = path
        explicit_checkpoint = None
    else:
        manifest_path = path.parent / LATEST_MANIFEST
        explicit_checkpoint = path
    if not manifest_path.is_file():
        raise CheckpointIntegrityError(f"latest manifest not found: {manifest_path}")
    try:
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CheckpointIntegrityError(
            f"cannot read latest manifest: {manifest_path}"
        ) from exc
    if not isinstance(manifest, dict):
        raise CheckpointSchemaError("latest manifest must be a JSON object")
    schema = manifest.get("schema")
    if schema != {"name": MANIFEST_SCHEMA_NAME, "version": MANIFEST_SCHEMA_VERSION}:
        raise CheckpointSchemaError(f"unsupported latest manifest schema: {schema!r}")
    checkpoint_name = manifest.get("checkpoint")
    if (
        not isinstance(checkpoint_name, str)
        or not checkpoint_name
        or Path(checkpoint_name).name != checkpoint_name
    ):
        raise CheckpointSchemaError("manifest checkpoint must be a local file name")
    checkpoint_path = manifest_path.parent / checkpoint_name
    if explicit_checkpoint is not None:
        if explicit_checkpoint.resolve() != checkpoint_path.resolve():
            raise CheckpointIntegrityError(
                f"latest manifest points to {checkpoint_path.name}, not {explicit_checkpoint.name}"
            )
        checkpoint_path = explicit_checkpoint
    if not checkpoint_path.is_file():
        raise CheckpointIntegrityError(f"checkpoint file not found: {checkpoint_path}")
    digest = manifest.get("sha256")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest.lower())
    ):
        raise CheckpointSchemaError("manifest contains an invalid SHA-256 digest")
    actual_digest = _sha256_file(checkpoint_path)
    if actual_digest.lower() != digest.lower():
        raise CheckpointIntegrityError(
            f"checkpoint digest mismatch for {checkpoint_path}: "
            f"expected {digest.lower()}, got {actual_digest}"
        )
    expected_size = manifest.get("size_bytes")
    if (
        isinstance(expected_size, bool)
        or not isinstance(expected_size, int)
        or expected_size < 0
        or checkpoint_path.stat().st_size != expected_size
    ):
        raise CheckpointIntegrityError(f"checkpoint size mismatch for {checkpoint_path}")
    return checkpoint_path, manifest


def _validate_payload(
    payload: Any,
    manifest: Mapping[str, Any],
    *,
    expected_config: Any | None,
    expected_config_hash: str | None,
    expected_source_hash: str | None,
    strict_source: bool,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CheckpointSchemaError("checkpoint payload must be a dictionary")
    schema = payload.get("schema")
    if schema != {"name": CHECKPOINT_SCHEMA_NAME, "version": CHECKPOINT_SCHEMA_VERSION}:
        raise CheckpointSchemaError(f"unsupported checkpoint schema: {schema!r}")
    required = {
        "config",
        "config_json",
        "config_hash",
        "source_hash",
        "model_state_dict",
        "optimizer_state_dict",
        "scheduler_state_dict",
        "scaler_state_dict",
        "buffer_state_dict",
        "trainer_state",
        "counters",
        "local_rng_state",
        "global_rng_state",
        "metadata",
    }
    missing = required.difference(payload)
    if missing:
        raise CheckpointSchemaError(
            f"checkpoint is missing fields: {', '.join(sorted(missing))}"
        )

    try:
        internal_config_json = canonical_config_json(payload["config"])
    except CheckpointConfigError:
        raise
    saved_config_json = payload["config_json"]
    if not isinstance(saved_config_json, str) or saved_config_json != internal_config_json:
        raise CheckpointConfigError("checkpoint canonical config does not match its config")
    saved_config_hash = hashlib.sha256(saved_config_json.encode("utf-8")).hexdigest()
    if payload["config_hash"] != saved_config_hash:
        raise CheckpointConfigError("checkpoint config hash is internally inconsistent")
    if manifest.get("config_hash") != saved_config_hash:
        raise CheckpointConfigError("manifest and checkpoint config hashes differ")
    if expected_config is not None:
        requested_hash = canonical_config_hash(expected_config)
        if expected_config_hash is not None and requested_hash != expected_config_hash:
            raise CheckpointConfigError(
                "expected_config and expected_config_hash disagree"
            )
        expected_config_hash = requested_hash
    if expected_config_hash is not None and saved_config_hash != expected_config_hash:
        raise CheckpointConfigError(
            f"checkpoint config hash mismatch: saved {saved_config_hash}, "
            f"expected {expected_config_hash}"
        )

    source_hash = payload["source_hash"]
    if not isinstance(source_hash, str) or not source_hash:
        raise CheckpointSchemaError("checkpoint source_hash must be a non-empty string")
    if manifest.get("source_hash") != source_hash:
        raise CheckpointSourceError("manifest and checkpoint source hashes differ")
    if manifest.get("checkpoint_schema_version") != CHECKPOINT_SCHEMA_VERSION:
        raise CheckpointSchemaError("manifest checkpoint schema version mismatch")
    if strict_source:
        if not isinstance(expected_source_hash, str) or not expected_source_hash:
            raise CheckpointSourceError(
                "strict source validation requires expected_source_hash; pass "
                "strict_source=False only for an intentional source migration"
            )
        if source_hash != expected_source_hash:
            raise CheckpointSourceError(
                f"checkpoint source hash mismatch: saved {source_hash}, "
                f"expected {expected_source_hash}"
            )
    return payload


def _move_to_device(value: Any, device: torch.device) -> Any:
    if torch.is_tensor(value):
        return value.to(device=device)
    if isinstance(value, MutableMapping):
        for key, item in list(value.items()):
            value[key] = _move_to_device(item, device)
        return value
    if isinstance(value, list):
        for index, item in enumerate(value):
            value[index] = _move_to_device(item, device)
        return value
    if isinstance(value, tuple):
        return tuple(_move_to_device(item, device) for item in value)
    return value


def _model_device(model: Any, map_location: Any) -> torch.device | None:
    parameters = getattr(model, "parameters", None)
    if callable(parameters):
        try:
            return next(iter(parameters())).device
        except StopIteration:
            pass
    if isinstance(map_location, (str, torch.device)):
        return torch.device(map_location)
    return None


def _move_optimizer_tensors(optimizer: Any, device: torch.device | None) -> None:
    if optimizer is None or device is None:
        return
    state = getattr(optimizer, "state", None)
    if not isinstance(state, MutableMapping):
        raise CheckpointError("optimizer does not expose a mutable state mapping")
    _move_to_device(state, device)


def load_checkpoint(
    path: str | os.PathLike[str],
    *,
    model: Any,
    optimizer: Any | None = None,
    scheduler: Any | None = None,
    scaler: Any | None = None,
    buffer: Any | None = None,
    local_rngs: Mapping[str, Any] | None = None,
    expected_config: Any | None = None,
    expected_config_hash: str | None = None,
    expected_source_hash: str | None = None,
    strict_source: bool = True,
    map_location: Any = "cpu",
    restore_global_rng: bool = True,
    restore_local_rng: bool = True,
    strict_model: bool = True,
) -> dict[str, Any]:
    """Validate and restore the checkpoint referenced by ``latest.json``.

    ``path`` may be a checkpoint directory, its ``latest.json``, or the exact
    checkpoint file named by that manifest.  Digest and schema validation occur
    before any caller-owned component is mutated.
    """

    checkpoint_path, manifest = _read_latest_manifest(Path(path))
    try:
        try:
            raw_payload = torch.load(
                checkpoint_path,
                map_location=map_location,
                weights_only=False,
            )
        except TypeError:  # PyTorch versions before the weights_only argument
            raw_payload = torch.load(checkpoint_path, map_location=map_location)
    except Exception as exc:
        raise CheckpointIntegrityError(
            f"checkpoint could not be deserialized: {checkpoint_path}"
        ) from exc
    payload = _validate_payload(
        raw_payload,
        manifest,
        expected_config=expected_config,
        expected_config_hash=expected_config_hash,
        expected_source_hash=expected_source_hash,
        strict_source=strict_source,
    )

    _load_state_dict(model, payload["model_state_dict"], "model", strict=strict_model)
    _load_state_dict(optimizer, payload["optimizer_state_dict"], "optimizer")
    _move_optimizer_tensors(optimizer, _model_device(model, map_location))
    _load_state_dict(scheduler, payload["scheduler_state_dict"], "scheduler")
    _load_state_dict(scaler, payload["scaler_state_dict"], "scaler")
    _load_state_dict(buffer, payload["buffer_state_dict"], "buffer")
    if restore_local_rng and local_rngs is not None:
        restore_local_rng_states(local_rngs, payload["local_rng_state"])
    if restore_global_rng:
        restore_global_rng_state(payload["global_rng_state"])

    payload["checkpoint_path"] = str(checkpoint_path.resolve())
    payload["manifest"] = dict(manifest)
    return payload


__all__ = [
    "CHECKPOINT_SCHEMA_NAME",
    "CHECKPOINT_SCHEMA_VERSION",
    "LATEST_MANIFEST",
    "CheckpointConfigError",
    "CheckpointError",
    "CheckpointIntegrityError",
    "CheckpointSchemaError",
    "CheckpointSourceError",
    "canonical_config_hash",
    "canonical_config_json",
    "capture_global_rng_state",
    "capture_local_rng_states",
    "compute_source_hash",
    "load_checkpoint",
    "restore_global_rng_state",
    "restore_local_rng_states",
    "save_checkpoint",
]
