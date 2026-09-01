#!/usr/bin/env python3
"""Independently verify D17 GEN-SIZE and D18 D16-v2 formal evidence.

This verifier deliberately does not import the D17-D19 runner or aggregator.  It
starts from the frozen manifest, explicit per-task pair plans, receipts, and raw
game records; replays every game through :mod:`lifeline_rl`; and only after the
independent numeric artifact has been built may it read a canonical numeric
interface for equality checking.

The formal gate is fail-closed.  ``formal_ready`` is initialized to ``False``
and becomes true only when every manifest, completeness, replay, diversity,
hash, pairing, inference, ledger, and canonical-comparison gate passes.
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import importlib
import importlib.abc
import importlib.util
import json
import math
import os
import random
import re
import stat
import statistics
import sys
import tempfile
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

LifelineGame: Any = None
Player: Any = None
replay_game_record: Any = None
_RUNTIME_SOURCE_BINDING: str | None = None
_RUNTIME_DEPENDENCY_BINDING: str | None = None
_RUNTIME_FILE_BINDINGS: dict[str, str] = {}
_RUNTIME_IMPORT_FINDER: Any = None


BUNDLE_ID = "d17_d19_lifeline_extension_20260829_v1"
GEN_SIZE_ID = "d17_gen_size_zero_shot_formal_v1"
D16_V2_ID = "d18_d16_v2_diverse_openings_formal_v1"
D16_V2_ARM = "d16-v2"
EXPECTED_TASKS = {GEN_SIZE_ID: 40, D16_V2_ID: 45}
EXPECTED_GAMES_PER_TASK = {GEN_SIZE_ID: 64, D16_V2_ID: 128}
EXPECTED_GROUPS = {GEN_SIZE_ID: 8, D16_V2_ID: 9}
EXPECTED_EXPORT_MANIFEST_ENTRIES = 4 + 3 * sum(EXPECTED_TASKS.values())
EXPECTED_TRAINING_SEEDS_PER_GROUP = 5
FROZEN_TRAINING_SEEDS = (20260825, 20260826, 20260827, 20260828, 20260829)
FROZEN_MODEL_KINDS = ("grid_gnn", "padded_cnn", "topology_gnn")
MIN_UNIQUE_FULL_BY_TASK = {GEN_SIZE_ID: 48, D16_V2_ID: 64}
MIN_UNIQUE_CONTINUATIONS_BY_TASK = {D16_V2_ID: 32}
MIN_DIVERSE_CLUSTERS_BY_TASK = {D16_V2_ID: 24}
MIN_CONTINUATIONS_PER_DIVERSE_CLUSTER = {D16_V2_ID: 2}
EXPECTED_OPENING_CLUSTERS_PER_TASK = {D16_V2_ID: 32}
FROZEN_BOOTSTRAP_SETTINGS = {
    GEN_SIZE_ID: (20_000, 202608299901),
    D16_V2_ID: (20_000, 202608299902),
}

# The verifier's replay-runtime trust root is deliberately separate from the
# frozen experiment manifest. Every module executed by ``import lifeline_rl``
# is compiled from these authenticated source bytes; adjacent ``.pyc`` files
# are never consulted.
VERIFIER_RUNTIME_SOURCE_HASHES = {
    "research/iclr2027/lifeline_rl/__init__.py": (
        "6e40ede87432a3b4258d0f31a9bbe87c92bb668885cc5c020e420c1388f47592"
    ),
    "research/iclr2027/lifeline_rl/arena.py": (
        "a613574baee606c2ed87de9eb0408dc61356b9ee2d41ed7a6f5b099d22ae9599"
    ),
    "research/iclr2027/lifeline_rl/core.py": (
        "a3219c931608ab76f466cf5278e6297ddfdf128b19d721a16fab895eb81e05e7"
    ),
    "research/iclr2027/lifeline_rl/encoding.py": (
        "b9a6a14cb627853936333968c8e931d7622b56ad6f0c48251b5e658d5494c33d"
    ),
    "research/iclr2027/lifeline_rl/env.py": (
        "b6b1d53b49057995a9b37bf1d87fd19fda15c68253fbaf9e2d8c6b032c6da03c"
    ),
    "research/iclr2027/lifeline_rl/agents/__init__.py": (
        "19018efcaba773b02152d92657893745d0a8a0b59684cb5333603e7f6fefe892"
    ),
    "research/iclr2027/lifeline_rl/agents/base.py": (
        "1ddec90c62491f747fdb670d042b60a99f7559487afdfc42e468f16990fd8b6c"
    ),
    "research/iclr2027/lifeline_rl/agents/cycle_seeking.py": (
        "1a227ccb1cce0bfe1a78dcc99baf6df05f0697fcf9f5fee12841bc3c661e552d"
    ),
    "research/iclr2027/lifeline_rl/agents/factory.py": (
        "737be45b442b17cf9d76c1f6223ed0c6e0dd059aebeaa3a25793a5f5d7d63481"
    ),
    "research/iclr2027/lifeline_rl/agents/greedy.py": (
        "6c7cd96cc96a7c4789ff0f78a08f40ba92ec4a5e7199f125978fd3c3483ba622"
    ),
    "research/iclr2027/lifeline_rl/agents/heuristic.py": (
        "f5a90d1989fa1d2466e9908e905026867fe1b3b9afd8f5027a17f466dc807a0c"
    ),
    "research/iclr2027/lifeline_rl/agents/mcts.py": (
        "0ab01dae6a796b00c61748a30670c2e6195b14f8edd02152fa1f6ffb4998acaf"
    ),
    "research/iclr2027/lifeline_rl/agents/minimax.py": (
        "4c905517cce420aa6b678975f208c370b02f252e4d39caa07d456ab164babb68"
    ),
    "research/iclr2027/lifeline_rl/agents/random_agent.py": (
        "416b7c94bc8cd989165a18543cefab03810561ae243958a4f42946305d3d628a"
    ),
}

PAIR_GAME_PLAN_FIELDS = (
    "task_id",
    "game_id",
    "game_index",
    "pair_id",
    "pair_index",
    "pair_member",
    "pair_color_orientation",
    "color_swap",
    "black_slot",
    "white_slot",
    "policy_seed_block",
    "policy_seed_a",
    "policy_seed_b",
    "policy_seed_assignment",
    "black_policy_seed",
    "white_policy_seed",
)

CHECKPOINT_BINDING_REQUIRED_FIELDS = (
    "checkpoint_id",
    "model_kind",
    "training_seed",
    "trained_board_sizes",
    "gradient_steps",
    "path",
    "sha256",
    "config_path",
    "config_hash",
    "config_file_sha256",
    "source_hash",
    "source_receipt_path",
    "source_receipt_sha256",
)

NUMERIC_SCHEMA = "lifeline-d17-d19-numeric-interface"
REPORT_SCHEMA = "lifeline-d17-d19-independent-verification"
INPUT_SNAPSHOT_SCHEMA = "lifeline-d17-d19-verifier-input-snapshot"
SCHEMA_VERSION = 1

CANONICAL_RECEIPT_BINDING_FIELDS = {
    "adapter_sha256",
    "runner_sha256",
    "experiments_sha256",
    "export_manifest_sha256",
    "export_payload_tree_sha256",
    "manifest_file_sha256",
    "manifest_canonical_sha256",
    "protocol_sha256",
    "task_manifest_sha256",
    "game_manifest_sha256",
    "result_ledger_sha256",
    "execution_metadata_sha256",
    "result_ledger_status_sha256",
    "execution_summary_sha256",
    "formal_source_hash",
}
CANONICAL_RECEIPT_COUNT_FIELDS = {
    "export_manifest_entries",
    "export_payload_files",
    "task_receipts",
    "task_summaries",
    "task_game_files",
    "game_rows",
    "complete_tasks",
    "gate_failed_tasks",
    "comparison_rows",
    "fingerprinted_input_files",
    "stable_input_roles",
}

GATE_NAMES = (
    "manifest_valid",
    "new_experiment_ids",
    "task_manifest_complete",
    "task_pair_plans_explicit",
    "receipt_ledger_complete",
    "ledger_status_bound",
    "no_failed_tasks",
    "no_missing_or_extra_games",
    "no_truncated_games",
    "all_games_replayed",
    "receipt_counts_recomputed",
    "checkpoint_source_config_hashes_bound",
    "protocol_runner_hashes_bound",
    "opening_prefixes_bound",
    "policy_seeds_bound",
    "paired_colors_complete",
    "pair_identity_combinations_unique",
    "opening_registry_reused",
    "unique_trajectory_thresholds_met",
    "statistical_units_valid",
    "seed_t_intervals_computed",
    "crossed_cluster_intervals_computed",
    "canonical_derivation_receipt_bound",
    "canonical_hash_verified",
    "canonical_numeric_match",
)


class VerificationError(ValueError):
    """Raised when independent formal verification cannot proceed safely."""


class _AuthenticatedRuntimeLoader(importlib.abc.Loader):
    """Compile one already-hashed source payload without consulting bytecode."""

    def __init__(self, fullname: str, specification: Mapping[str, Any]) -> None:
        self.fullname = fullname
        self.path = Path(specification["path"])
        self.payload = bytes(specification["payload"])
        self.sha256 = str(specification["sha256"])
        self.is_package = bool(specification["is_package"])

    def create_module(self, spec: Any) -> None:
        return None

    def exec_module(self, module: Any) -> None:
        module.__file__ = str(self.path)
        module.__cached__ = None
        module.__loader__ = self
        code = compile(
            self.payload,
            str(self.path),
            "exec",
            dont_inherit=True,
        )
        exec(code, module.__dict__)


class _AuthenticatedRuntimeFinder(importlib.abc.MetaPathFinder):
    """Allow only the explicit, pre-authenticated ``lifeline_rl`` closure."""

    def __init__(self, sources: Mapping[str, Mapping[str, Any]]) -> None:
        self.sources = {name: dict(value) for name, value in sources.items()}

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: Any = None,
    ) -> Any:
        if fullname != "lifeline_rl" and not fullname.startswith("lifeline_rl."):
            return None
        specification = self.sources.get(fullname)
        if specification is None:
            raise VerificationError(
                f"lifeline replay runtime requested undeclared module: {fullname}"
            )
        loader = _AuthenticatedRuntimeLoader(fullname, specification)
        search_locations = (
            [str(Path(specification["path"]).parent)]
            if specification["is_package"]
            else None
        )
        spec = importlib.util.spec_from_file_location(
            fullname,
            specification["path"],
            loader=loader,
            submodule_search_locations=search_locations,
        )
        if spec is None:
            raise VerificationError(
                f"cannot create authenticated runtime module spec: {fullname}"
            )
        return spec


def _authenticated_runtime_sources() -> dict[str, dict[str, Any]]:
    snapshot = _ACTIVE_INPUT_SNAPSHOT
    if snapshot is None:
        raise VerificationError(
            "runtime source authentication requires an active snapshot"
        )
    sources: dict[str, dict[str, Any]] = {}
    for source_name, declared_sha256 in VERIFIER_RUNTIME_SOURCE_HASHES.items():
        source_path = _resolve_artifact_path(
            source_name,
            base=REPOSITORY_ROOT,
            label=f"verifier.runtime_source_hashes.{source_name}",
        )
        payload = snapshot.read_bytes(
            source_path,
            label=f"authenticated replay runtime source {source_name}",
        )
        observed_sha256 = hashlib.sha256(payload).hexdigest()
        if observed_sha256 != declared_sha256:
            raise VerificationError(
                f"verifier replay runtime source hash mismatch: {source_name}"
            )
        try:
            relative = source_path.relative_to(RESEARCH_ROOT)
        except ValueError as exc:
            raise VerificationError(
                f"verifier replay runtime source is outside research root: {source_path}"
            ) from exc
        if relative.parts[0] != "lifeline_rl" or relative.suffix != ".py":
            raise VerificationError(
                f"invalid verifier replay runtime source path: {source_name}"
            )
        module_parts = list(relative.with_suffix("").parts)
        is_package = module_parts[-1] == "__init__"
        if is_package:
            module_parts.pop()
        module_name = ".".join(module_parts)
        if not module_name or module_name in sources:
            raise VerificationError(
                f"duplicate verifier replay runtime module binding: {module_name}"
            )
        sources[module_name] = {
            "path": source_path,
            "payload": payload,
            "sha256": declared_sha256,
            "is_package": is_package,
        }
    if "lifeline_rl" not in sources:
        raise VerificationError("verifier replay runtime package source is not bound")
    return dict(sorted(sources.items()))


def _load_lifeline_runtime(source_hashes: Mapping[str, Any]) -> None:
    """Import the replay runtime only inside a verified filesystem snapshot."""

    global LifelineGame, Player, replay_game_record, _RUNTIME_SOURCE_BINDING
    global _RUNTIME_DEPENDENCY_BINDING, _RUNTIME_FILE_BINDINGS
    global _RUNTIME_IMPORT_FINDER
    if _ACTIVE_INPUT_SNAPSHOT is None:
        raise VerificationError(
            "lifeline replay runtime import requires an active snapshot"
        )
    manifest_binding = _canonical_sha256(dict(sorted(source_hashes.items())))
    dependency_binding = _canonical_sha256(VERIFIER_RUNTIME_SOURCE_HASHES)
    if _RUNTIME_SOURCE_BINDING is not None:
        if _RUNTIME_SOURCE_BINDING != manifest_binding:
            raise VerificationError(
                "loaded lifeline runtime differs from source bindings"
            )
        if _RUNTIME_DEPENDENCY_BINDING != dependency_binding:
            raise VerificationError("verifier runtime dependency binding changed")
        observed_files = _loaded_lifeline_file_bindings()
        if observed_files != _RUNTIME_FILE_BINDINGS:
            raise VerificationError(
                "loaded lifeline runtime files changed between runs"
            )
        return
    if any(
        name == "lifeline_rl" or name.startswith("lifeline_rl.") for name in sys.modules
    ):
        raise VerificationError(
            "lifeline_rl was imported before verifier source authentication"
        )
    sources = _authenticated_runtime_sources()
    finder = _AuthenticatedRuntimeFinder(sources)
    sys.meta_path.insert(0, finder)
    try:
        importlib.invalidate_caches()
        module = importlib.import_module("lifeline_rl")
        loaded_game = getattr(module, "LifelineGame", None)
        loaded_player = getattr(module, "Player", None)
        loaded_replay = getattr(module, "replay_game_record", None)
        if loaded_game is None or loaded_player is None or not callable(loaded_replay):
            raise VerificationError("lifeline replay runtime interface is incomplete")
        _verify_source_files(source_hashes, label="runtime.source_hashes_after_import")
        loaded_bindings = _loaded_lifeline_file_bindings(sources)
        if not loaded_bindings:
            raise VerificationError("lifeline replay runtime loaded no auditable files")
    except BaseException:
        if finder in sys.meta_path:
            sys.meta_path.remove(finder)
        for module_name in tuple(sys.modules):
            if module_name == "lifeline_rl" or module_name.startswith("lifeline_rl."):
                sys.modules.pop(module_name, None)
        importlib.invalidate_caches()
        raise
    LifelineGame = loaded_game
    Player = loaded_player
    replay_game_record = loaded_replay
    _RUNTIME_SOURCE_BINDING = manifest_binding
    _RUNTIME_DEPENDENCY_BINDING = dependency_binding
    _RUNTIME_FILE_BINDINGS = loaded_bindings
    _RUNTIME_IMPORT_FINDER = finder


def _loaded_lifeline_file_bindings(
    sources: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, str]:
    if sources is None:
        if not isinstance(_RUNTIME_IMPORT_FINDER, _AuthenticatedRuntimeFinder):
            raise VerificationError(
                "authenticated replay runtime finder is unavailable"
            )
        sources = _RUNTIME_IMPORT_FINDER.sources
    bindings: dict[str, str] = {}
    observed_modules: set[str] = set()
    for module_name, module in sorted(sys.modules.items()):
        if module_name != "lifeline_rl" and not module_name.startswith("lifeline_rl."):
            continue
        specification = sources.get(module_name)
        if specification is None:
            raise VerificationError(
                f"loaded lifeline runtime module lacks an authenticated source: {module_name}"
            )
        loader = getattr(module, "__loader__", None)
        if not isinstance(loader, _AuthenticatedRuntimeLoader):
            raise VerificationError(
                f"lifeline runtime module bypassed authenticated loader: {module_name}"
            )
        if getattr(module, "__cached__", None) not in (None, ""):
            raise VerificationError(
                f"lifeline runtime module exposed a bytecode cache: {module_name}"
            )
        resolved = _ACTIVE_INPUT_SNAPSHOT.resolve_file(
            getattr(module, "__file__", ""),
            label=f"loaded authenticated runtime {module_name}.source",
        )
        expected_path = Path(specification["path"])
        if resolved != expected_path or loader.path != expected_path:
            raise VerificationError(
                f"loaded lifeline runtime source path mismatch: {module_name}"
            )
        observed_sha256 = _sha256_file(resolved)
        if (
            observed_sha256 != specification["sha256"]
            or loader.sha256 != specification["sha256"]
        ):
            raise VerificationError(
                f"loaded lifeline runtime source hash mismatch: {module_name}"
            )
        relative = resolved.relative_to(RESEARCH_ROOT)
        key = f"{module_name}:source:{relative.as_posix()}"
        bindings[key] = observed_sha256
        observed_modules.add(module_name)
    if observed_modules != set(sources):
        missing = sorted(set(sources) - observed_modules)
        extra = sorted(observed_modules - set(sources))
        raise VerificationError(
            "authenticated replay runtime module closure mismatch: "
            f"missing={missing}, extra={extra}"
        )
    return dict(sorted(bindings.items()))


_WINDOWS_REPARSE_POINT = 0x400
_AT_FDCWD = -100
_RENAME_NOREPLACE = 1
_ACTIVE_INPUT_SNAPSHOT: _InputSnapshot | None = None


def _stat_identity(value: os.stat_result) -> dict[str, int]:
    """Return the lstat/fstat fields used to detect a mixed input snapshot."""

    return {
        "device": int(value.st_dev),
        "inode": int(value.st_ino),
        "mode": int(value.st_mode),
        "size": int(value.st_size),
        "mtime_ns": int(value.st_mtime_ns),
        "ctime_ns": int(value.st_ctime_ns),
        "file_attributes": int(getattr(value, "st_file_attributes", 0)),
    }


def _is_link_or_reparse(value: os.stat_result) -> bool:
    return stat.S_ISLNK(value.st_mode) or bool(
        int(getattr(value, "st_file_attributes", 0)) & _WINDOWS_REPARSE_POINT
    )


def _same_open_file(value: os.stat_result, lstat_value: os.stat_result) -> bool:
    """Compare handle/lstat identity without Windows CRT's divergent ctime."""

    fields = (
        "st_dev",
        "st_ino",
        "st_mode",
        "st_size",
        "st_mtime_ns",
        "st_file_attributes",
    )
    return all(
        int(getattr(value, field, 0)) == int(getattr(lstat_value, field, 0))
        for field in fields
    )


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path))


def _contains_parent_reference(path: Path) -> bool:
    return any(part == ".." for part in path.parts)


def _reject_reparse_ancestry(path: Path, *, label: str) -> None:
    """Reject a link/reparse point anywhere from the filesystem anchor down."""

    absolute = Path(os.path.abspath(path))
    anchor = Path(absolute.anchor)
    try:
        relative = absolute.relative_to(anchor)
    except ValueError as exc:
        raise VerificationError(
            f"{label}: path has no stable filesystem anchor"
        ) from exc
    current = anchor
    components = [current]
    for part in relative.parts:
        current = current / part
        components.append(current)
    for component in components:
        try:
            component_lstat = component.lstat()
        except OSError as exc:
            raise VerificationError(
                f"{label}: path component is missing: {component}"
            ) from exc
        if _is_link_or_reparse(component_lstat):
            raise VerificationError(
                f"{label}: symlink/reparse ancestry is forbidden: {component}"
            )


class _InputSnapshot:
    """Allowlist, read, and fingerprint every file consumed by a verification."""

    def __init__(self, roots: Mapping[str, Path]) -> None:
        if not roots:
            raise VerificationError("input allowlist is empty")
        resolved_roots: list[tuple[str, Path]] = []
        seen: set[str] = set()
        for root_id, raw_root in roots.items():
            if not root_id or _contains_parent_reference(Path(raw_root)):
                raise VerificationError(f"invalid allowlisted root {root_id!r}")
            absolute = Path(os.path.abspath(raw_root))
            _reject_reparse_ancestry(
                absolute, label=f"allowlisted input root {root_id!r}"
            )
            try:
                root_lstat = absolute.lstat()
            except OSError as exc:
                raise VerificationError(
                    f"allowlisted input root does not exist: {absolute}"
                ) from exc
            if _is_link_or_reparse(root_lstat):
                raise VerificationError(
                    f"allowlisted input root is a symlink/reparse point: {absolute}"
                )
            try:
                resolved = absolute.resolve(strict=True)
            except OSError as exc:
                raise VerificationError(
                    f"cannot resolve allowlisted input root: {absolute}"
                ) from exc
            if not resolved.is_dir():
                raise VerificationError(
                    f"allowlisted input root is not a directory: {resolved}"
                )
            key = _path_key(resolved)
            if key in seen:
                continue
            seen.add(key)
            resolved_roots.append((root_id, resolved))
        self._roots = tuple(
            sorted(resolved_roots, key=lambda item: len(item[1].parts), reverse=True)
        )
        self._records: dict[str, dict[str, Any]] = {}

    @property
    def roots(self) -> tuple[tuple[str, Path], ...]:
        return self._roots

    def _match_lexical_root(self, absolute: Path) -> tuple[str, Path, Path]:
        for root_id, root in self._roots:
            try:
                relative = absolute.relative_to(root)
            except ValueError:
                continue
            return root_id, root, relative
        raise VerificationError(
            f"input path is outside every explicit allowlisted root: {absolute}"
        )

    def resolve_file(self, path: str | Path, *, label: str) -> Path:
        raw = Path(path)
        if _contains_parent_reference(raw):
            raise VerificationError(f"{label}: parent path components are forbidden")
        absolute = Path(os.path.abspath(raw))
        root_id, lexical_root, relative = self._match_lexical_root(absolute)
        current = lexical_root
        for part in relative.parts:
            current = current / part
            try:
                current_lstat = current.lstat()
            except OSError as exc:
                raise VerificationError(
                    f"{label}: input file is missing: {current}"
                ) from exc
            if _is_link_or_reparse(current_lstat):
                raise VerificationError(
                    f"{label}: symlink/reparse input is forbidden: {current}"
                )
        try:
            resolved = absolute.resolve(strict=True)
            resolved.relative_to(lexical_root)
        except (OSError, ValueError) as exc:
            raise VerificationError(
                f"{label}: resolved input escapes allowlisted root {root_id!r}: {absolute}"
            ) from exc
        try:
            final_lstat = resolved.lstat()
        except OSError as exc:
            raise VerificationError(
                f"{label}: cannot lstat input file: {resolved}"
            ) from exc
        if _is_link_or_reparse(final_lstat) or not stat.S_ISREG(final_lstat.st_mode):
            raise VerificationError(
                f"{label}: input must be a regular non-reparse file: {resolved}"
            )
        return resolved

    def _root_label(self, resolved: Path) -> tuple[str, str]:
        for root_id, root in self._roots:
            try:
                relative = resolved.relative_to(root)
            except ValueError:
                continue
            return root_id, relative.as_posix()
        raise VerificationError(f"resolved input lost its allowlisted root: {resolved}")

    def _capture(
        self, path: str | Path, *, label: str, return_bytes: bool
    ) -> tuple[str, bytes | None]:
        resolved = self.resolve_file(path, label=label)
        try:
            before_lstat = resolved.lstat()
            digest = hashlib.sha256()
            chunks: list[bytes] | None = [] if return_bytes else None
            with resolved.open("rb") as handle:
                opened_before = os.fstat(handle.fileno())
                if not _same_open_file(opened_before, before_lstat):
                    raise VerificationError(
                        f"{label}: input identity changed before read: {resolved}"
                    )
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    if chunks is not None:
                        chunks.append(chunk)
                opened_after = os.fstat(handle.fileno())
            after_lstat = resolved.lstat()
        except VerificationError:
            raise
        except OSError as exc:
            raise VerificationError(
                f"{label}: cannot read input file {resolved}: {exc}"
            ) from exc
        identity = _stat_identity(before_lstat)
        if (
            not _same_open_file(opened_before, before_lstat)
            or _stat_identity(opened_after) != _stat_identity(opened_before)
            or _stat_identity(after_lstat) != identity
        ):
            raise VerificationError(
                f"{label}: input changed while being read: {resolved}"
            )
        root_id, relative_path = self._root_label(resolved)
        record = {
            "root_id": root_id,
            "relative_path": relative_path,
            "sha256": digest.hexdigest(),
            "size": identity["size"],
            "lstat_identity": identity,
        }
        key = _path_key(resolved)
        prior = self._records.get(key)
        if prior is not None and prior != record:
            raise VerificationError(
                f"{label}: input changed between verification reads: {resolved}"
            )
        self._records[key] = record
        payload = b"".join(chunks) if chunks is not None else None
        return record["sha256"], payload

    def sha256(self, path: str | Path, *, label: str) -> str:
        digest, _ = self._capture(path, label=label, return_bytes=False)
        return digest

    def read_bytes(self, path: str | Path, *, label: str) -> bytes:
        _, payload = self._capture(path, label=label, return_bytes=True)
        assert payload is not None
        return payload

    def verify_unchanged(self) -> dict[str, Any]:
        initial_paths = tuple(self._records)
        for key in initial_paths:
            self._capture(Path(key), label="final input snapshot", return_bytes=False)
        entries = sorted(
            self._records.values(),
            key=lambda item: (item["root_id"], item["relative_path"]),
        )
        content_entries = [
            {
                "root_id": item["root_id"],
                "relative_path": item["relative_path"],
                "size": item["size"],
                "sha256": item["sha256"],
            }
            for item in entries
        ]
        root_rows = [
            {"root_id": root_id, "path": str(root)} for root_id, root in self._roots
        ]
        fingerprint_payload = {
            "schema_name": INPUT_SNAPSHOT_SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "identity_scope": "filesystem_lstat_and_content_snapshot",
            "entries": entries,
        }
        return {
            **fingerprint_payload,
            "allowlisted_roots": root_rows,
            "input_count": len(entries),
            "content_set_sha256": _canonical_sha256(content_entries),
            "complete_fingerprint_sha256": _canonical_sha256(fingerprint_payload),
            "verified_unchanged_after_verification": True,
        }


def _reject_constant(token: str) -> None:
    raise VerificationError(f"non-finite JSON constant is forbidden: {token}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def _strict_json_text(text: str, *, label: str) -> Any:
    try:
        return json.loads(
            text,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise VerificationError(f"invalid strict JSON in {label}: {exc}") from exc


def load_json(path: str | Path) -> Any:
    source = Path(path)
    try:
        if _ACTIVE_INPUT_SNAPSHOT is None:
            text = source.read_text(encoding="utf-8")
        else:
            text = _ACTIVE_INPUT_SNAPSHOT.read_bytes(
                source, label=f"JSON input {source}"
            ).decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise VerificationError(f"cannot read JSON file {source}: {exc}") from exc
    return _strict_json_text(text, label=str(source))


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    source = Path(path)
    try:
        if _ACTIVE_INPUT_SNAPSHOT is None:
            text = source.read_text(encoding="utf-8")
        else:
            text = _ACTIVE_INPUT_SNAPSHOT.read_bytes(
                source, label=f"JSONL input {source}"
            ).decode("utf-8")
        lines = text.splitlines()
    except (OSError, UnicodeError) as exc:
        raise VerificationError(f"cannot read JSONL file {source}: {exc}") from exc
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        value = _strict_json_text(line, label=f"{source}:{line_number}")
        if not isinstance(value, dict):
            raise VerificationError(f"{source}:{line_number}: expected a JSON object")
        rows.append(value)
    return rows


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise VerificationError(f"value is not finite canonical JSON: {exc}") from exc


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _sha256_file(path: str | Path) -> str:
    source = Path(path)
    if _ACTIVE_INPUT_SNAPSHOT is not None:
        return _ACTIVE_INPUT_SNAPSHOT.sha256(source, label=f"SHA-256 input {source}")
    digest = hashlib.sha256()
    try:
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise VerificationError(f"cannot hash file {source}: {exc}") from exc
    return digest.hexdigest()


def _valid_sha256(value: Any) -> bool:
    return (
        isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value) is not None
    )


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise VerificationError(f"{label}: expected an object")
    return value


def _sequence(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise VerificationError(f"{label}: expected an array")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise VerificationError(f"{label}: expected a non-empty string")
    return value


def _integer(value: Any, label: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise VerificationError(f"{label}: expected an integer")
    if minimum is not None and value < minimum:
        raise VerificationError(f"{label}: expected >= {minimum}")
    return value


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise VerificationError(f"{label}: expected a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise VerificationError(f"{label}: expected a finite number")
    return result


def _first(mapping: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    return default


def _require(mapping: Mapping[str, Any], names: Iterable[str], label: str) -> None:
    missing = [name for name in names if name not in mapping]
    if missing:
        raise VerificationError(f"{label}: missing fields {', '.join(missing)}")


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(
            value,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _stage_json(path: Path, value: Mapping[str, Any]) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(_json_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        return temporary
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _link_staged_exclusive(temporary: Path, path: Path) -> None:
    try:
        os.link(temporary, path)
    except FileExistsError as exc:
        raise VerificationError(f"refusing to overwrite raced output: {path}") from exc


def _path_object_identity(value: os.stat_result) -> dict[str, int]:
    """Return fields that identify one filesystem object across a rename."""

    return {
        "device": int(value.st_dev),
        "inode": int(value.st_ino),
        "mode": int(value.st_mode),
        "file_attributes": int(getattr(value, "st_file_attributes", 0)),
    }


def _directory_object_identity(path: Path, *, label: str) -> dict[str, int]:
    try:
        value = path.lstat()
    except OSError as exc:
        raise VerificationError(f"{label}: cannot lstat directory: {path}") from exc
    if _is_link_or_reparse(value) or not stat.S_ISDIR(value.st_mode):
        raise VerificationError(f"{label}: expected a non-reparse directory: {path}")
    return _path_object_identity(value)


def _capture_output_file(path: Path, *, label: str) -> dict[str, Any]:
    try:
        before_lstat = path.lstat()
        if _is_link_or_reparse(before_lstat) or not stat.S_ISREG(before_lstat.st_mode):
            raise VerificationError(
                f"{label}: expected a regular non-reparse file: {path}"
            )
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            opened_before = os.fstat(handle.fileno())
            if not _same_open_file(opened_before, before_lstat):
                raise VerificationError(
                    f"{label}: output identity changed before read: {path}"
                )
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            opened_after = os.fstat(handle.fileno())
        after_lstat = path.lstat()
    except VerificationError:
        raise
    except OSError as exc:
        raise VerificationError(f"{label}: cannot read output file: {path}") from exc
    if not _same_open_file(opened_after, opened_before) or _stat_identity(
        after_lstat
    ) != _stat_identity(before_lstat):
        raise VerificationError(f"{label}: output changed while being read: {path}")
    link_count = int(before_lstat.st_nlink)
    if link_count != 1:
        raise VerificationError(
            f"{label}: output must have exactly one filesystem link: {path}"
        )
    return {
        "sha256": digest.hexdigest(),
        "size": int(before_lstat.st_size),
        "link_count": link_count,
        "lstat_identity": _stat_identity(before_lstat),
        "object_identity": _path_object_identity(before_lstat),
    }


def _write_private_json(path: Path, value: Mapping[str, Any]) -> dict[str, Any]:
    """Create one new JSON file inside an unpublished private directory."""

    temporary = _stage_json(path, value)
    staged_sha256 = _sha256_file(temporary)
    try:
        _link_staged_exclusive(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    receipt = _capture_output_file(path, label="private staged JSON")
    if receipt["sha256"] != staged_sha256:
        raise VerificationError(f"private staged JSON changed after creation: {path}")
    return receipt


def _rename_path_no_replace(source: Path, destination: Path) -> None:
    """Atomically move one directory only when the destination is absent."""

    if os.name == "nt":
        try:
            os.rename(source, destination)
        except OSError as exc:
            if isinstance(exc, FileExistsError) or exc.errno in {
                errno.EEXIST,
                errno.ENOTEMPTY,
            }:
                raise VerificationError(
                    f"refusing to replace raced output directory: {destination}"
                ) from exc
            raise
        return

    if sys.platform.startswith("linux"):
        try:
            library = ctypes.CDLL(None, use_errno=True)
        except OSError as exc:
            raise VerificationError(
                "atomic no-replace directory publication is unavailable"
            ) from exc
        renameat2 = getattr(library, "renameat2", None)
        if renameat2 is None:
            raise VerificationError(
                "atomic no-replace directory publication is unavailable"
            )
        renameat2.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        renameat2.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = renameat2(
            _AT_FDCWD,
            os.fsencode(source),
            _AT_FDCWD,
            os.fsencode(destination),
            _RENAME_NOREPLACE,
        )
        if result == 0:
            return
        error_number = ctypes.get_errno()
        if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
            raise VerificationError(
                f"refusing to replace raced output directory: {destination}"
            )
        raise OSError(
            error_number,
            os.strerror(error_number),
            str(destination),
        )

    raise VerificationError(
        f"atomic no-replace directory publication is unsupported on {sys.platform}"
    )


def _prepare_new_output_directory(
    output_directory: str | Path,
) -> tuple[Path, Path, dict[str, int]]:
    raw = Path(output_directory)
    if _contains_parent_reference(raw):
        raise VerificationError("verification output path cannot contain '..'")
    output = Path(os.path.abspath(raw))
    if not output.name or output == output.parent:
        raise VerificationError("verification output path must name a new directory")
    parent = output.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise VerificationError(
            f"cannot create verification output parent: {parent}"
        ) from exc
    _reject_reparse_ancestry(parent, label="verification output parent")
    parent_identity = _directory_object_identity(
        parent, label="verification output parent"
    )
    if os.path.lexists(output):
        raise VerificationError(f"refusing to reuse verification directory: {output}")
    return output, parent, parent_identity


def _validate_published_directory(
    output_directory: Path,
    *,
    directory_identity: Mapping[str, int],
    file_receipts: Mapping[str, Mapping[str, Any]],
) -> None:
    before_identity = _directory_object_identity(
        output_directory, label="published verification directory"
    )
    if before_identity != dict(directory_identity):
        raise VerificationError("published verification directory identity changed")
    try:
        observed_names = {entry.name for entry in output_directory.iterdir()}
    except OSError as exc:
        raise VerificationError(
            f"cannot enumerate published verification directory: {output_directory}"
        ) from exc
    expected_names = set(file_receipts)
    if observed_names != expected_names:
        raise VerificationError(
            "published verification directory does not have the exact file set"
        )
    for name, expected_receipt in file_receipts.items():
        observed_receipt = _capture_output_file(
            output_directory / name, label=f"published verification output {name}"
        )
        if observed_receipt != dict(expected_receipt):
            raise VerificationError(
                f"published verification output identity or SHA changed: {name}"
            )
    after_identity = _directory_object_identity(
        output_directory, label="published verification directory"
    )
    if after_identity != before_identity:
        raise VerificationError(
            "published verification directory changed during final validation"
        )


def _validate_publication(publication: Mapping[str, Any]) -> None:
    _validate_published_directory(
        Path(publication["path"]),
        directory_identity=publication["directory_identity"],
        file_receipts=publication["files"],
    )


def _quarantine_publication(publication: Mapping[str, Any]) -> Path:
    """Move a committed-but-invalid directory away from its requested name."""

    output = Path(publication["path"])
    parent = output.parent
    expected_parent = dict(publication["parent_identity"])
    if (
        _directory_object_identity(parent, label="verification output parent")
        != expected_parent
    ):
        raise VerificationError(
            "cannot quarantine output after its parent identity changed"
        )
    if _directory_object_identity(
        output, label="invalid published verification directory"
    ) != dict(publication["directory_identity"]):
        raise VerificationError(
            "cannot quarantine output after its directory identity changed"
        )
    quarantine = parent / f".{output.name}.quarantine-{uuid.uuid4().hex}"
    if os.path.lexists(quarantine):
        raise VerificationError(
            f"verification quarantine path already exists: {quarantine}"
        )
    _rename_path_no_replace(output, quarantine)
    if os.path.lexists(output):
        raise VerificationError("invalid verification output remained after quarantine")
    if _directory_object_identity(
        quarantine, label="quarantined verification directory"
    ) != dict(publication["directory_identity"]):
        raise VerificationError("quarantined verification directory identity changed")
    if (
        _directory_object_identity(parent, label="verification output parent")
        != expected_parent
    ):
        raise VerificationError(
            "verification output parent changed while quarantining invalid output"
        )
    return quarantine


def _publish_json_directory(
    output_directory: str | Path,
    payloads: Mapping[str, Mapping[str, Any]],
    *,
    expected_target: tuple[Path, Path, dict[str, int]] | None = None,
) -> dict[str, Any]:
    """Build all payloads privately, then publish the whole directory once.

    Any exceptional return leaves private staging under its hidden random name.
    Such a directory is quarantine only; it is never a partially published
    verification result.  Recursive cleanup is deliberately avoided because a
    concurrent writer could replace a staged path between validation and unlink.
    """

    if not payloads:
        raise VerificationError("verification output payload set is empty")
    for name in payloads:
        if Path(name).name != name or name in {"", ".", ".."}:
            raise VerificationError(f"invalid verification output name: {name!r}")
    target = _prepare_new_output_directory(output_directory)
    if expected_target is not None and target != expected_target:
        raise VerificationError(
            "verification output target or parent identity changed since preflight"
        )
    output, parent, parent_identity = target
    try:
        stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=parent))
    except OSError as exc:
        raise VerificationError(
            f"cannot create private verification staging directory: {parent}"
        ) from exc
    stage_identity = _directory_object_identity(
        stage, label="private verification staging directory"
    )
    file_receipts = {
        name: _write_private_json(stage / name, value)
        for name, value in payloads.items()
    }
    _validate_published_directory(
        stage,
        directory_identity=stage_identity,
        file_receipts=file_receipts,
    )
    if (
        _directory_object_identity(parent, label="verification output parent")
        != parent_identity
    ):
        raise VerificationError(
            "verification output parent identity changed before commit"
        )
    commit_error: BaseException | None = None
    try:
        _rename_path_no_replace(stage, output)
    except BaseException as exc:
        commit_error = exc
        try:
            if os.path.lexists(stage):
                raise VerificationError(
                    "private staging still exists after failed directory commit"
                )
            if (
                _directory_object_identity(
                    output, label="reconciled verification directory"
                )
                != stage_identity
            ):
                raise VerificationError(
                    "failed directory commit did not publish this staging identity"
                )
        except BaseException as reconciliation_error:
            raise commit_error from reconciliation_error
    publication = {
        "path": output,
        "parent_identity": parent_identity,
        "directory_identity": stage_identity,
        "files": file_receipts,
    }
    try:
        if os.path.lexists(stage):
            raise VerificationError(
                "private verification staging directory still exists after commit"
            )
        if (
            _directory_object_identity(parent, label="verification output parent")
            != parent_identity
        ):
            raise VerificationError(
                "verification output parent identity changed during commit"
            )
        _validate_publication(publication)
    except BaseException as validation_error:
        try:
            quarantine = _quarantine_publication(publication)
        except BaseException as quarantine_error:
            raise validation_error from quarantine_error
        raise VerificationError(
            "committed verification directory failed validation and was quarantined "
            f"at {quarantine}: {validation_error}"
        ) from validation_error
    return publication


def _publish_output_pair(
    *,
    output_directory: Path,
    numeric: Mapping[str, Any],
    report: dict[str, Any],
    expected_target: tuple[Path, Path, dict[str, int]] | None = None,
) -> dict[str, Any]:
    numeric_path = Path(os.path.abspath(output_directory)) / "independent_numeric.json"
    numeric_sha256 = hashlib.sha256(_json_bytes(numeric)).hexdigest()
    report["independent_numeric"] = {
        "path": str(numeric_path.resolve()),
        "sha256": numeric_sha256,
    }
    return _publish_json_directory(
        output_directory,
        {
            "independent_numeric.json": numeric,
            "independent_verification.json": report,
        },
        expected_target=expected_target,
    )


def _publish_failure_report(
    *,
    output_directory: Path,
    report: Mapping[str, Any],
    expected_target: tuple[Path, Path, dict[str, int]] | None = None,
) -> dict[str, Any]:
    return _publish_json_directory(
        output_directory,
        {"independent_verification.json": report},
        expected_target=expected_target,
    )


def _resolve_artifact_path(value: Any, *, base: Path, label: str) -> Path:
    raw = _string(value, label)
    raw_path = Path(raw)
    normalized = raw.replace("\\", "/")
    marker = "/formal_run/"
    if normalized.startswith("/root/autodl-tmp/jobs/") and marker in normalized:
        suffix = normalized.split(marker, 1)[1]
        parts = suffix.split("/")
        if not parts or any(part in ("", ".", "..") for part in parts):
            raise VerificationError(f"{label}: invalid relocated AutoDL artifact path")
        candidate = Path(base).joinpath(*parts)
    else:
        if _contains_parent_reference(raw_path):
            raise VerificationError(f"{label}: parent path components are forbidden")
        candidate = raw_path if raw_path.is_absolute() else Path(base) / raw_path

    base_absolute = Path(os.path.abspath(base))
    candidate_absolute = Path(os.path.abspath(candidate))
    try:
        candidate_absolute.relative_to(base_absolute)
    except ValueError as exc:
        raise VerificationError(
            f"{label}: absolute foreign artifact injection is forbidden: {candidate}"
        ) from exc

    snapshot = _ACTIVE_INPUT_SNAPSHOT
    if snapshot is None:
        snapshot = _InputSnapshot({"artifact_base": base_absolute})
    resolved = snapshot.resolve_file(candidate_absolute, label=label)
    try:
        resolved.relative_to(base_absolute.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise VerificationError(
            f"{label}: resolved artifact escapes its input root"
        ) from exc
    return resolved


def _manifest_bundle_id(manifest: Mapping[str, Any]) -> str:
    return str(
        _first(
            manifest, "bundle_id", "experiment_bundle_id", "experiment_id", default=""
        )
    )


def _manifest_task_rows(
    manifest: Mapping[str, Any], task_manifest_path: Path | None
) -> tuple[list[dict[str, Any]], str | None]:
    if task_manifest_path is not None:
        if task_manifest_path.suffix.lower() == ".jsonl":
            rows = load_jsonl(task_manifest_path)
        else:
            payload = load_json(task_manifest_path)
            if isinstance(payload, list):
                rows = payload
            elif isinstance(payload, Mapping):
                rows = _sequence(
                    _first(payload, "tasks", "formal_tasks", "task_manifest"),
                    f"{task_manifest_path}.tasks",
                )
            else:
                raise VerificationError(
                    "task manifest must be JSONL or a JSON task array"
                )
        if not all(isinstance(row, dict) for row in rows):
            raise VerificationError("every task-manifest row must be an object")
        return [dict(row) for row in rows], _sha256_file(task_manifest_path)

    embedded = _first(manifest, "tasks", "formal_tasks", "task_manifest")
    if isinstance(embedded, list):
        if not all(isinstance(row, dict) for row in embedded):
            raise VerificationError("every embedded task row must be an object")
        return [dict(row) for row in embedded], _canonical_sha256(embedded)
    raise VerificationError(
        "frozen formal tasks are absent; provide --task-manifest or embed tasks in manifest"
    )


def _validate_manifest_identity(manifest: Mapping[str, Any]) -> None:
    if not manifest:
        raise VerificationError("manifest is empty")
    if _manifest_bundle_id(manifest) != BUNDLE_ID:
        raise VerificationError(
            f"manifest bundle id must be the new experiment id {BUNDLE_ID!r}"
        )
    if manifest.get("status") != "frozen_not_run":
        raise VerificationError("source manifest status must be frozen_not_run")
    protocol_path = _string(manifest.get("protocol_path"), "manifest.protocol_path")
    protocol_sha256 = manifest.get("protocol_sha256")
    if not _valid_sha256(protocol_sha256):
        raise VerificationError("manifest.protocol_sha256 is invalid")
    source_hashes = _mapping(manifest.get("source_hashes"), "manifest.source_hashes")
    if source_hashes.get(protocol_path) != protocol_sha256:
        raise VerificationError(
            "manifest source hashes do not bind the D17-D19 protocol"
        )
    protocol = _resolve_artifact_path(
        protocol_path,
        base=REPOSITORY_ROOT,
        label="manifest.protocol_path",
    )
    if _sha256_file(protocol) != protocol_sha256:
        raise VerificationError("frozen D17-D19 protocol file/hash binding failed")
    formal_gates = _mapping(manifest.get("formal_gates"), "manifest.formal_gates")
    if formal_gates.get("any_gate_failure_sets_formal_ready_false") is not True:
        raise VerificationError("manifest does not freeze a fail-closed formal gate")
    serialized = _canonical_json(manifest)
    forbidden = (
        "d14_d16_three_representation_formal_v1",
        "D14_D16_RESULTS.md",
    )
    if any(token in serialized for token in forbidden):
        # Checkpoint provenance can mention the old run path, but the new manifest
        # must never claim the old experiment/result identity as its own.
        own_identity = str(
            _first(manifest, "bundle_id", "experiment_bundle_id", default="")
        )
        if own_identity != BUNDLE_ID:
            raise VerificationError(
                "manifest reuses a frozen D14-D16 experiment identity"
            )


def _verify_readonly_bindings(manifest: Mapping[str, Any]) -> int:
    bindings = _sequence(
        manifest.get("readonly_bindings"), "manifest.readonly_bindings"
    )
    if not bindings:
        raise VerificationError("manifest readonly bindings are empty")
    verified = 0
    for index, raw in enumerate(bindings):
        binding = _mapping(raw, f"manifest.readonly_bindings[{index}]")
        path_value = _string(binding.get("path"), f"readonly_bindings[{index}].path")
        digest = binding.get("sha256")
        if not _valid_sha256(digest):
            raise VerificationError(f"readonly_bindings[{index}].sha256 is invalid")
        resolved = _resolve_artifact_path(
            path_value,
            base=REPOSITORY_ROOT,
            label=f"readonly_bindings[{index}].path",
        )
        if _sha256_file(resolved) != str(digest).lower():
            raise VerificationError(f"readonly binding hash mismatch: {path_value}")
        verified += 1
    return verified


def _normalize_actions(value: Any, label: str) -> list[int]:
    raw = _sequence(value, label)
    actions: list[int] = []
    for index, item in enumerate(raw):
        action = item.get("action") if isinstance(item, Mapping) else item
        actions.append(_integer(action, f"{label}[{index}]", minimum=0))
    return actions


def _opening_prefix_hash(actions: Sequence[int]) -> str:
    return _canonical_sha256(list(actions))


def _apply_action_index(game: LifelineGame, action_index: int, label: str) -> None:
    if action_index > game.num_points:
        raise VerificationError(f"{label}: action exceeds PASS index {game.num_points}")
    action = (
        None if action_index == game.num_points else game.valid_positions[action_index]
    )
    result = game.skip_turn() if action is None else game.play_move(action)
    if not result.success:
        raise VerificationError(f"{label}: illegal replay action: {result.reason}")


def _opening_state_hash(
    *, grid_size: int, superko_mode: str, opening_actions: Sequence[int]
) -> str:
    game = LifelineGame(grid_size, superko_mode=superko_mode)
    for index, action in enumerate(opening_actions):
        if game.game_over:
            raise VerificationError(
                f"opening prefix continues after terminal action at index {index}"
            )
        _apply_action_index(game, action, f"opening_actions[{index}]")
    return hashlib.sha256(game.canonical_state_json().encode("utf-8")).hexdigest()


def _require_runner_binding(
    value: Mapping[str, Any], expected_sha256: str, *, label: str
) -> None:
    observed = value.get("runner_sha256")
    if not _valid_sha256(observed):
        raise VerificationError(f"{label}.runner_sha256 is missing or invalid")
    if observed != expected_sha256:
        raise VerificationError(
            f"{label}.runner_sha256 does not match the current runner"
        )


def _plan_game_ids(plan: Mapping[str, Any], *, label: str = "pair_plan") -> list[str]:
    raw_ids = _sequence(plan.get("game_ids"), f"{label}.game_ids")
    if len(raw_ids) != 2:
        raise VerificationError(f"{label}.game_ids must contain exactly two entries")
    game_ids = [
        _string(value, f"{label}.game_ids[{index}]")
        for index, value in enumerate(raw_ids)
    ]
    if game_ids[0] == game_ids[1]:
        raise VerificationError(f"{label}.game_ids must be distinct")

    raw_game_plan = _sequence(plan.get("game_plan"), f"{label}.game_plan")
    if len(raw_game_plan) != 2:
        raise VerificationError(f"{label}.game_plan must contain exactly two entries")
    planned_ids = [
        _string(
            _mapping(raw_game, f"{label}.game_plan[{index}]").get("game_id"),
            f"{label}.game_plan[{index}].game_id",
        )
        for index, raw_game in enumerate(raw_game_plan)
    ]
    if game_ids != planned_ids:
        raise VerificationError(
            f"{label}.game_ids disagree with game_plan order or identity"
        )
    return game_ids


def _validate_pair_game_plan(
    task: Mapping[str, Any], plan: Mapping[str, Any], *, label: str
) -> list[dict[str, Any]]:
    """Validate the task-embedded, per-game frozen identity and randomness plan."""

    game_ids = _plan_game_ids(plan, label=label)
    raw_game_plan = _sequence(plan.get("game_plan"), f"{label}.game_plan")
    result: list[dict[str, Any]] = []
    for member, raw_game in enumerate(raw_game_plan):
        game_label = f"{label}.game_plan[{member}]"
        game = dict(_mapping(raw_game, game_label))
        _require(game, PAIR_GAME_PLAN_FIELDS, game_label)
        if set(game) != set(PAIR_GAME_PLAN_FIELDS):
            missing = sorted(set(PAIR_GAME_PLAN_FIELDS) - set(game))
            extra = sorted(set(game) - set(PAIR_GAME_PLAN_FIELDS))
            raise VerificationError(
                f"{game_label}: game-plan schema differs ({missing=} {extra=})"
            )
        if game["task_id"] != task.get("task_id"):
            raise VerificationError(f"{game_label}: task id mismatch")
        if game["game_id"] != game_ids[member]:
            raise VerificationError(f"{game_label}: game id mismatch")
        if game["pair_id"] != plan.get("pair_id"):
            raise VerificationError(f"{game_label}: pair id mismatch")
        pair_index = _integer(plan.get("pair_index"), f"{label}.pair_index", minimum=0)
        if game["pair_index"] != pair_index:
            raise VerificationError(f"{game_label}: pair index mismatch")
        if game["game_index"] != pair_index * 2 + member:
            raise VerificationError(f"{game_label}: game index mismatch")
        for field in ("pair_member", "pair_color_orientation", "color_swap"):
            if game[field] != member:
                raise VerificationError(f"{game_label}: {field} must equal {member}")
        expected_slots = ("A", "B") if member == 0 else ("B", "A")
        if (game["black_slot"], game["white_slot"]) != expected_slots:
            raise VerificationError(f"{game_label}: slot/color assignment mismatch")
        for field in (
            "policy_seed_block",
            "policy_seed_a",
            "policy_seed_b",
            "policy_seed_assignment",
        ):
            if game[field] != plan.get(field):
                raise VerificationError(f"{game_label}: {field} differs from pair plan")
        seed_a = _integer(
            plan.get("policy_seed_a"), f"{label}.policy_seed_a", minimum=0
        )
        seed_b = _integer(
            plan.get("policy_seed_b"), f"{label}.policy_seed_b", minimum=0
        )
        expected_policy_seeds = (seed_a, seed_b) if member == 0 else (seed_b, seed_a)
        if (
            game["black_policy_seed"],
            game["white_policy_seed"],
        ) != expected_policy_seeds:
            raise VerificationError(
                f"{game_label}: slot/policy-seed assignment mismatch"
            )
        result.append(game)
    return result


def _verify_pair_against_game_manifest(
    task: Mapping[str, Any],
    plan: Mapping[str, Any],
    manifest_games: Sequence[Mapping[str, Any]],
    *,
    label: str,
) -> list[dict[str, Any]]:
    embedded_games = _validate_pair_game_plan(task, plan, label=label)
    if len(manifest_games) != 2:
        raise VerificationError(
            f"{label}: frozen game manifest must contain two members"
        )
    result: list[dict[str, Any]] = []
    for member, raw_manifest_game in enumerate(manifest_games):
        manifest_game = dict(
            _mapping(raw_manifest_game, f"{label}.game_manifest[{member}]")
        )
        embedded_game = embedded_games[member]
        for field in PAIR_GAME_PLAN_FIELDS:
            if manifest_game.get(field) != embedded_game[field]:
                raise VerificationError(
                    f"{label}: game manifest differs from game_plan[{member}] at {field}"
                )
        result.append(manifest_game)
    return result


def _attach_game_manifest(
    tasks: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    runner_sha256: str,
) -> list[dict[str, Any]]:
    """Attach the separately frozen per-game plan to each task pair plan."""

    if len(games) != sum(
        EXPECTED_TASKS[key] * EXPECTED_GAMES_PER_TASK[key] for key in EXPECTED_TASKS
    ):
        raise VerificationError(f"game manifest has {len(games)} rows; expected 8,320")
    by_task_pair: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    seen_game_ids: set[str] = set()
    for index, raw_game in enumerate(games):
        game = dict(_mapping(raw_game, f"game_manifest[{index}]"))
        _require(
            game,
            (
                "task_id",
                "game_id",
                "game_index",
                "pair_id",
                "pair_index",
                "pair_member",
                "pair_color_orientation",
                "color_swap",
                "black_slot",
                "white_slot",
                "training_seed",
                "opening_cluster",
                "opening_id",
                "opening_seed",
                "opening_actions",
                "opening_prefix_hash",
                "opening_state_hash",
                "checkpoint_bindings",
                "policy_seed_block",
                "policy_seed_a",
                "policy_seed_b",
                "policy_seed_assignment",
                "black_policy_seed",
                "white_policy_seed",
                "runner_sha256",
            ),
            f"game_manifest[{index}]",
        )
        game_id = _string(game["game_id"], f"game_manifest[{index}].game_id")
        _require_runner_binding(game, runner_sha256, label=f"game_manifest[{index}]")
        if game_id in seen_game_ids:
            raise VerificationError(f"duplicate game-manifest id {game_id!r}")
        seen_game_ids.add(game_id)
        if (
            game["pair_member"] not in {0, 1}
            or game["color_swap"] != game["pair_member"]
        ):
            raise VerificationError(
                f"game_manifest[{index}]: invalid pair member/color swap"
            )
        if game["pair_color_orientation"] != game["pair_member"]:
            raise VerificationError(
                f"game_manifest[{index}]: pair orientation mismatch"
            )
        expected_slots = ("A", "B") if game["pair_member"] == 0 else ("B", "A")
        if (game["black_slot"], game["white_slot"]) != expected_slots:
            raise VerificationError(
                f"game_manifest[{index}]: slot/color assignment mismatch"
            )
        by_task_pair[(str(game["task_id"]), str(game["pair_id"]))].append(game)

    enriched: list[dict[str, Any]] = []
    consumed: set[tuple[str, str]] = set()
    for raw_task in tasks:
        task = dict(raw_task)
        _require_runner_binding(
            task, runner_sha256, label=str(task.get("task_id", "task"))
        )
        derived_group = _derived_inference_group_id(task)
        declared_group = task.get("inference_group_id")
        if declared_group is not None and declared_group != derived_group:
            raise VerificationError(
                f"{task.get('task_id')}: inference_group_id disagrees with frozen task fields"
            )
        # The group is independently derived from frozen model/opponent/size
        # fields.  This does not alter the task-manifest file or its hash.
        task["inference_group_id"] = derived_group
        plans: list[dict[str, Any]] = []
        for plan_index, raw_plan in enumerate(
            _sequence(task.get("pair_plan"), f"{task.get('task_id')}.pair_plan")
        ):
            plan = dict(_mapping(raw_plan, "pair_plan entry"))
            key = (str(task.get("task_id")), str(plan.get("pair_id")))
            planned_games = sorted(
                by_task_pair.get(key, []), key=lambda game: int(game["pair_member"])
            )
            plan_label = f"{task.get('task_id')}.pair_plan[{plan_index}]"
            bound_games = _verify_pair_against_game_manifest(
                task, plan, planned_games, label=plan_label
            )
            for member, bound_game in enumerate(bound_games):
                _verify_game_checkpoint_bindings(
                    task,
                    bound_game,
                    label=f"{plan_label}.game_manifest[{member}]",
                )
            plan["_planned_games"] = bound_games
            plans.append(plan)
            consumed.add(key)
        task["pair_plan"] = plans
        enriched.append(task)
    extra = set(by_task_pair) - consumed
    if extra:
        raise VerificationError(
            f"game manifest contains {len(extra)} unplanned task/pair keys"
        )
    return enriched


def _derived_inference_group_id(task: Mapping[str, Any]) -> str:
    experiment_id = str(task.get("experiment_id"))
    size = _integer(task.get("eval_size"), "task.eval_size", minimum=2)
    if experiment_id == GEN_SIZE_ID:
        specs = _mapping(task.get("agent_specs"), "task.agent_specs")
        agent_a = _mapping(specs.get("A"), "task.agent_specs.A")
        model_kind = _string(agent_a.get("model_kind"), "task.agent_specs.A.model_kind")
        opponent = _string(task.get("opponent"), "task.opponent")
        return f"gen_size.{model_kind}.n{size}.vs.{opponent}"
    if experiment_id == D16_V2_ID:
        pair = _sequence(task.get("model_pair"), "task.model_pair")
        if len(pair) != 2:
            raise VerificationError(
                "D16-v2 task model_pair must contain two model kinds"
            )
        model_a = _string(pair[0], "task.model_pair[0]")
        model_b = _string(pair[1], "task.model_pair[1]")
        return f"d16-v2.{model_a}_vs_{model_b}.n{size}"
    raise VerificationError(f"cannot derive inference group for {experiment_id!r}")


def _task_pair_plan(task: Mapping[str, Any], label: str) -> list[dict[str, Any]]:
    plans = _sequence(task.get("pair_plan"), f"{label}.pair_plan")
    return [
        dict(_mapping(plan, f"{label}.pair_plan[{index}]"))
        for index, plan in enumerate(plans)
    ]


def _validate_task_rows(
    tasks: Sequence[Mapping[str, Any]],
    manifest_sha256: str,
    protocol_sha256: str,
    runner_sha256: str,
    checkpoint_registry: Mapping[str, Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    if not tasks:
        raise VerificationError("task manifest is empty")
    expected_total = sum(EXPECTED_TASKS.values())
    if len(tasks) != expected_total:
        raise VerificationError(
            f"task manifest has {len(tasks)} rows; expected exactly {expected_total}"
        )
    by_id: dict[str, Mapping[str, Any]] = {}
    counts: Counter[str] = Counter()
    global_game_ids: set[str] = set()
    for index, task in enumerate(tasks):
        label = f"tasks[{index}]"
        _require(
            task,
            (
                "task_id",
                "experiment_id",
                "experiment_arm",
                "evidence_tier",
                "training_seed",
                "eval_size",
                "games",
                "max_plies",
                "superko_mode",
                "source_hashes",
                "agent_specs",
                "checkpoint_bindings",
                "manifest_sha256",
                "protocol_sha256",
                "runner_sha256",
                "pair_plan",
            ),
            label,
        )
        task_id = _string(task["task_id"], f"{label}.task_id")
        if task_id in by_id:
            raise VerificationError(f"duplicate task id {task_id!r}")
        experiment_id = _string(task["experiment_id"], f"{label}.experiment_id")
        if experiment_id not in EXPECTED_TASKS:
            raise VerificationError(
                f"{label}: unexpected experiment id {experiment_id!r}"
            )
        if experiment_id == D16_V2_ID and task["experiment_arm"] != D16_V2_ARM:
            raise VerificationError(
                f"{label}: D18 arm must be spelled exactly {D16_V2_ARM!r}"
            )
        if task["evidence_tier"] != "formal":
            raise VerificationError(f"{label}: evidence_tier must be formal")
        _integer(task["training_seed"], f"{label}.training_seed", minimum=0)
        _integer(task["eval_size"], f"{label}.eval_size", minimum=2)
        games = _integer(task["games"], f"{label}.games", minimum=2)
        if games != EXPECTED_GAMES_PER_TASK[experiment_id] or games % 2:
            raise VerificationError(
                f"{label}: expected {EXPECTED_GAMES_PER_TASK[experiment_id]} paired games"
            )
        _integer(task["max_plies"], f"{label}.max_plies", minimum=1)
        if task["superko_mode"] not in {"enforce", "observe"}:
            raise VerificationError(f"{label}: invalid Superko mode")
        if task["manifest_sha256"] != manifest_sha256:
            raise VerificationError(f"{label}: frozen manifest SHA-256 mismatch")
        if task["protocol_sha256"] != protocol_sha256:
            raise VerificationError(f"{label}: frozen protocol SHA-256 mismatch")
        _require_runner_binding(task, runner_sha256, label=label)
        _string(task["inference_group_id"], f"{label}.inference_group_id")
        _validate_task_checkpoint_bindings(
            task, checkpoint_registry=checkpoint_registry, label=label
        )

        source_hashes = _mapping(task["source_hashes"], f"{label}.source_hashes")
        for source_name, digest in source_hashes.items():
            if not isinstance(source_name, str) or not _valid_sha256(digest):
                raise VerificationError(f"{label}.source_hashes: invalid entry")

        for hash_field in (
            "checkpoint_sha256",
            "config_hash",
            "source_hash",
        ):
            if hash_field in task:
                values = _collect_named_values(task[hash_field], hash_field)
                if not values or any(not _valid_sha256(value) for value in values):
                    raise VerificationError(
                        f"{label}.{hash_field}: invalid SHA-256 binding"
                    )

        plans = _task_pair_plan(task, label)
        if len(plans) != games // 2:
            raise VerificationError(
                f"{label}: expected {games // 2} explicit pair-plan entries, got {len(plans)}"
            )
        pair_ids: set[str] = set()
        identity_keys: set[tuple[Any, ...]] = set()
        for plan_index, plan in enumerate(plans):
            plan_label = f"{label}.pair_plan[{plan_index}]"
            _require(
                plan,
                (
                    "pair_id",
                    "pair_index",
                    "opening_cluster",
                    "opening_id",
                    "opening_seed",
                    "opening_actions",
                    "opening_prefix_hash",
                    "opening_state_hash",
                    "policy_seed_a",
                    "policy_seed_b",
                    "policy_seed_assignment",
                    "policy_seed_block",
                    "color_swaps",
                    "game_ids",
                    "game_plan",
                ),
                plan_label,
            )
            pair_id = _string(plan["pair_id"], f"{plan_label}.pair_id")
            if pair_id in pair_ids:
                raise VerificationError(f"{label}: duplicate pair id {pair_id!r}")
            pair_ids.add(pair_id)
            _integer(plan["pair_index"], f"{plan_label}.pair_index", minimum=0)
            opening_actions = _normalize_actions(
                plan["opening_actions"], f"{plan_label}.opening_actions"
            )
            if plan["opening_prefix_hash"] != _opening_prefix_hash(opening_actions):
                raise VerificationError(f"{plan_label}: opening prefix hash mismatch")
            expected_state_hash = _opening_state_hash(
                grid_size=int(task["eval_size"]),
                superko_mode=str(task["superko_mode"]),
                opening_actions=opening_actions,
            )
            if plan["opening_state_hash"] != expected_state_hash:
                raise VerificationError(f"{plan_label}: opening state hash mismatch")
            seed_a = _integer(
                plan["policy_seed_a"], f"{plan_label}.policy_seed_a", minimum=0
            )
            seed_b = _integer(
                plan["policy_seed_b"], f"{plan_label}.policy_seed_b", minimum=0
            )
            if seed_a == seed_b:
                raise VerificationError(f"{plan_label}: A/B policy seeds must differ")
            if plan["color_swaps"] != [0, 1]:
                raise VerificationError(
                    f"{plan_label}: color_swaps must be exactly [0, 1]"
                )
            _validate_pair_game_plan(task, plan, label=plan_label)
            game_ids = _plan_game_ids(plan, label=plan_label)
            if len(game_ids) != 2 or game_ids[0] == game_ids[1]:
                raise VerificationError(
                    f"{plan_label}: pair must declare two distinct games"
                )
            for game_id in game_ids:
                if game_id in global_game_ids:
                    raise VerificationError(f"duplicate planned game id {game_id!r}")
                global_game_ids.add(game_id)
            identity = (
                task_id,
                task["training_seed"],
                plan["opening_id"],
                plan["opening_seed"],
                seed_a,
                seed_b,
                _canonical_json(plan["policy_seed_assignment"]),
            )
            if identity in identity_keys:
                raise VerificationError(
                    f"{plan_label}: duplicate opening/policy/seed identity"
                )
            identity_keys.add(identity)

        counts[experiment_id] += 1
        by_id[task_id] = task

    if dict(counts) != EXPECTED_TASKS:
        raise VerificationError(
            f"task counts are {dict(counts)}, expected {EXPECTED_TASKS}"
        )
    return by_id


def _collect_named_values(value: Any, key: str) -> set[str]:
    values: set[str] = set()
    if isinstance(value, str):
        values.add(value)
    elif isinstance(value, Mapping):
        for nested_key, nested_value in value.items():
            if nested_key == key and isinstance(nested_value, str):
                values.add(nested_value)
            else:
                values.update(_collect_named_values(nested_value, key))
    elif isinstance(value, list):
        for nested in value:
            values.update(_collect_named_values(nested, key))
    return values


def _all_values_for_key(value: Any, key: str) -> set[str]:
    values: set[str] = set()
    if isinstance(value, Mapping):
        for nested_key, nested_value in value.items():
            if nested_key == key and isinstance(nested_value, str):
                values.add(nested_value)
            values.update(_all_values_for_key(nested_value, key))
    elif isinstance(value, list):
        for nested in value:
            values.update(_all_values_for_key(nested, key))
    return values


def _load_receipt_ledger(
    receipts_path: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ledger_rows = load_jsonl(receipts_path)
    receipts: list[dict[str, Any]] = []
    for index, row in enumerate(ledger_rows):
        receipt_path_value = _first(row, "receipt_path", "path")
        if receipt_path_value is None:
            receipts.append(dict(row))
            continue
        receipt_path = _resolve_artifact_path(
            receipt_path_value,
            base=receipts_path.parent,
            label=f"ledger[{index}].receipt_path",
        )
        declared_hash = _first(row, "receipt_sha256", "sha256")
        if (
            not _valid_sha256(declared_hash)
            or _sha256_file(receipt_path) != declared_hash
        ):
            raise VerificationError(f"ledger[{index}]: receipt artifact hash mismatch")
        payload = load_json(receipt_path)
        receipts.append(dict(_mapping(payload, f"receipt {receipt_path}")))
    return receipts, ledger_rows


def _artifact_field(receipt: Mapping[str, Any], kind: str) -> tuple[Any, Any]:
    direct_path = _first(
        receipt,
        f"arena_{kind}_path",
        f"{kind}_path",
        default=None,
    )
    direct_hash = _first(
        receipt,
        f"arena_{kind}_sha256",
        f"{kind}_sha256",
        default=None,
    )
    if direct_path is not None:
        return direct_path, direct_hash
    artifacts = receipt.get("artifacts")
    if isinstance(artifacts, Mapping):
        entry = artifacts.get(kind)
        if isinstance(entry, Mapping):
            return entry.get("path"), entry.get("sha256")
    return None, None


def _receipt_count(receipt: Mapping[str, Any], *names: str) -> int:
    value = _first(receipt, *names, default=None)
    return _integer(value, f"receipt.{names[0]}", minimum=0)


def _validate_file_binding(
    path_value: Any, digest_value: Any, *, base: Path, label: str
) -> Path:
    path = _resolve_artifact_path(path_value, base=base, label=f"{label}.path")
    if not _valid_sha256(digest_value):
        raise VerificationError(f"{label}.sha256: invalid SHA-256")
    actual = _sha256_file(path)
    if actual != str(digest_value).lower():
        raise VerificationError(f"{label}: SHA-256 mismatch")
    return path


def _verify_source_files(source_hashes: Mapping[str, Any], *, label: str) -> None:
    for source_name, declared in source_hashes.items():
        if not _valid_sha256(declared):
            raise VerificationError(f"{label}.{source_name}: invalid SHA-256")
        path = Path(source_name)
        normalized = str(path).replace("\\", "/")
        source_base = (
            REPOSITORY_ROOT
            if path.is_absolute() or normalized.startswith("research/iclr2027/")
            else RESEARCH_ROOT
        )
        resolved = _resolve_artifact_path(
            source_name,
            base=source_base,
            label=f"{label}.{source_name}",
        )
        if _sha256_file(resolved) != str(declared).lower():
            raise VerificationError(f"{label}.{source_name}: source file hash mismatch")


def _validate_checkpoint_binding_schema(
    value: Mapping[str, Any], *, label: str
) -> dict[str, Any]:
    binding = dict(_mapping(value, label))
    _require(binding, CHECKPOINT_BINDING_REQUIRED_FIELDS, label)
    for field in (
        "checkpoint_id",
        "model_kind",
        "path",
        "config_path",
        "source_receipt_path",
    ):
        _string(binding[field], f"{label}.{field}")
    for field in (
        "sha256",
        "config_hash",
        "config_file_sha256",
        "source_hash",
        "source_receipt_sha256",
    ):
        if not _valid_sha256(binding[field]):
            raise VerificationError(f"{label}.{field} is not a valid SHA-256")
    _integer(binding["training_seed"], f"{label}.training_seed", minimum=0)
    _integer(binding["gradient_steps"], f"{label}.gradient_steps", minimum=1)
    sizes = _sequence(binding["trained_board_sizes"], f"{label}.trained_board_sizes")
    if [
        _integer(size, f"{label}.trained_board_sizes[]", minimum=2) for size in sizes
    ] != [
        5,
        7,
        9,
    ]:
        raise VerificationError(
            f"{label}.trained_board_sizes must be exactly [5, 7, 9]"
        )
    return binding


def _manifest_checkpoint_registry(
    manifest: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    rows = _sequence(manifest.get("checkpoints"), "manifest.checkpoints")
    expected_count = len(FROZEN_TRAINING_SEEDS) * len(FROZEN_MODEL_KINDS)
    if len(rows) != expected_count:
        raise VerificationError(
            f"manifest checkpoint registry has {len(rows)} rows; expected {expected_count}"
        )
    registry: dict[str, dict[str, Any]] = {}
    observed_cells: set[tuple[str, int]] = set()
    for index, raw_binding in enumerate(rows):
        label = f"manifest.checkpoints[{index}]"
        binding = _validate_checkpoint_binding_schema(
            _mapping(raw_binding, label), label=label
        )
        checkpoint_id = str(binding["checkpoint_id"])
        if checkpoint_id in registry:
            raise VerificationError(
                f"duplicate manifest checkpoint id {checkpoint_id!r}"
            )
        cell = (str(binding["model_kind"]), int(binding["training_seed"]))
        if cell in observed_cells:
            raise VerificationError(f"duplicate manifest checkpoint cell {cell!r}")
        observed_cells.add(cell)
        registry[checkpoint_id] = binding
    expected_cells = {
        (model_kind, training_seed)
        for model_kind in FROZEN_MODEL_KINDS
        for training_seed in FROZEN_TRAINING_SEEDS
    }
    if observed_cells != expected_cells:
        raise VerificationError(
            "manifest checkpoint registry does not cover the frozen matrix"
        )
    return registry


def _validate_task_checkpoint_bindings(
    task: Mapping[str, Any],
    *,
    checkpoint_registry: Mapping[str, Mapping[str, Any]],
    label: str,
) -> None:
    specs = _mapping(task.get("agent_specs"), f"{label}.agent_specs")
    bindings = _mapping(task.get("checkpoint_bindings"), f"{label}.checkpoint_bindings")
    if set(specs) != {"A", "B"} or set(bindings) != {"A", "B"}:
        raise VerificationError(
            f"{label}: agent/checkpoint slots must be exactly A and B"
        )
    for slot in ("A", "B"):
        spec = dict(_mapping(specs[slot], f"{label}.agent_specs.{slot}"))
        binding_value = bindings[slot]
        if spec.get("kind") == "learned_checkpoint":
            binding = _validate_checkpoint_binding_schema(
                _mapping(binding_value, f"{label}.checkpoint_bindings.{slot}"),
                label=f"{label}.checkpoint_bindings.{slot}",
            )
            spec_payload = dict(spec)
            spec_payload.pop("kind", None)
            if spec_payload != binding:
                raise VerificationError(
                    f"{label}: learned agent {slot} differs from checkpoint binding"
                )
            registered = checkpoint_registry.get(str(binding["checkpoint_id"]))
            if registered is None or binding != registered:
                raise VerificationError(
                    f"{label}: learned agent {slot} differs from frozen checkpoint registry"
                )
        elif spec.get("kind") == "search_baseline":
            if binding_value is not None:
                raise VerificationError(
                    f"{label}: baseline agent {slot} must have a null checkpoint binding"
                )
        else:
            raise VerificationError(f"{label}: unsupported agent kind for slot {slot}")


def _verify_receipt_checkpoint_bindings(
    task: Mapping[str, Any], receipt: Mapping[str, Any]
) -> None:
    if receipt.get("checkpoint_bindings") != task.get("checkpoint_bindings"):
        raise VerificationError(
            "receipt checkpoint_bindings do not exactly match the frozen task"
        )


def _verify_game_checkpoint_bindings(
    task: Mapping[str, Any], game: Mapping[str, Any], *, label: str
) -> None:
    if game.get("checkpoint_bindings") != task.get("checkpoint_bindings"):
        raise VerificationError(
            f"{label}.checkpoint_bindings do not exactly match the frozen task"
        )


def _verify_checkpoint_paths(value: Any, *, label: str) -> int:
    verified = 0
    if isinstance(value, Mapping):
        is_checkpoint = "checkpoint_id" in value or "checkpoint_sha256" in value
        path_value = (
            _first(value, "checkpoint_path", "path", default=None)
            if is_checkpoint
            else None
        )
        digest_value = _first(value, "checkpoint_sha256", "sha256", default=None)
        if path_value is not None and digest_value is not None:
            path = Path(str(path_value))
            normalized = str(path).replace("\\", "/")
            checkpoint_base = (
                REPOSITORY_ROOT
                if path.is_absolute() or normalized.startswith("research/iclr2027/")
                else RESEARCH_ROOT
            )
            resolved = _resolve_artifact_path(
                str(path), base=checkpoint_base, label=f"{label}.checkpoint_path"
            )
            if (
                not _valid_sha256(digest_value)
                or _sha256_file(resolved) != str(digest_value).lower()
            ):
                raise VerificationError(f"{label}: checkpoint file hash mismatch")
            verified += 1
        config_path_value = value.get("config_path")
        config_file_sha256 = value.get("config_file_sha256")
        if config_path_value is not None and config_file_sha256 is not None:
            config_path = Path(str(config_path_value))
            normalized = str(config_path).replace("\\", "/")
            config_base = (
                REPOSITORY_ROOT
                if config_path.is_absolute()
                or normalized.startswith("research/iclr2027/")
                else RESEARCH_ROOT
            )
            resolved_config = _resolve_artifact_path(
                str(config_path),
                base=config_base,
                label=f"{label}.config_path",
            )
            if (
                not _valid_sha256(config_file_sha256)
                or _sha256_file(resolved_config) != str(config_file_sha256).lower()
            ):
                raise VerificationError(
                    f"{label}: checkpoint config file hash mismatch"
                )
            verified += 1
        source_receipt_path_value = value.get("source_receipt_path")
        source_receipt_sha256 = value.get("source_receipt_sha256")
        if (source_receipt_path_value is None) != (source_receipt_sha256 is None):
            raise VerificationError(
                f"{label}: source receipt path and SHA-256 must be bound together"
            )
        if source_receipt_path_value is not None:
            source_receipt_path = Path(str(source_receipt_path_value))
            normalized = str(source_receipt_path).replace("\\", "/")
            receipt_base = (
                REPOSITORY_ROOT
                if source_receipt_path.is_absolute()
                or normalized.startswith("research/iclr2027/")
                else RESEARCH_ROOT
            )
            resolved_receipt = _resolve_artifact_path(
                str(source_receipt_path),
                base=receipt_base,
                label=f"{label}.source_receipt_path",
            )
            if (
                not _valid_sha256(source_receipt_sha256)
                or _sha256_file(resolved_receipt) != str(source_receipt_sha256).lower()
            ):
                raise VerificationError(f"{label}: source receipt file hash mismatch")
            verified += 1
        for key, nested in value.items():
            if key not in {
                "checkpoint_path",
                "path",
                "checkpoint_sha256",
                "sha256",
                "config_path",
                "config_file_sha256",
                "source_receipt_path",
                "source_receipt_sha256",
            }:
                verified += _verify_checkpoint_paths(nested, label=f"{label}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            verified += _verify_checkpoint_paths(nested, label=f"{label}[{index}]")
    return verified


def _plan_value(plan: Mapping[str, Any], *names: str) -> Any:
    return _first(plan, *names, default=None)


def _match_plan_field(
    game: Mapping[str, Any],
    plan: Mapping[str, Any],
    *,
    game_names: Sequence[str],
    plan_names: Sequence[str],
    label: str,
) -> None:
    game_value = _first(game, *game_names, default=None)
    plan_value = _first(plan, *plan_names, default=None)
    if game_value != plan_value:
        raise VerificationError(
            f"{label}: game {game_names[0]}={game_value!r} does not match plan {plan_value!r}"
        )


def _action_indices(record: Mapping[str, Any]) -> list[int]:
    actions = _sequence(record.get("actions"), "game.actions")
    return [
        _integer(
            _mapping(action, f"game.actions[{index}]").get("action"),
            f"game.actions[{index}].action",
            minimum=0,
        )
        for index, action in enumerate(actions)
    ]


def _trajectory_hashes(
    record: Mapping[str, Any], opening_actions: Sequence[int]
) -> dict[str, str]:
    actions = _action_indices(record)
    if actions[: len(opening_actions)] != list(opening_actions):
        raise VerificationError(
            "raw action trace does not begin with the registered opening prefix"
        )
    continuation = actions[len(opening_actions) :]
    common = {
        "grid_size": record.get("grid_size"),
        "superko_mode": record.get("superko_mode"),
    }
    full_key = {
        **common,
        "opening": list(opening_actions),
        "continuation": continuation,
        "black_slot": record.get("black_slot"),
        "white_slot": record.get("white_slot"),
    }
    full_sequence = {**common, "actions": actions}
    continuation_with_slots = {
        **common,
        "continuation": continuation,
        "black_slot": record.get("black_slot"),
        "white_slot": record.get("white_slot"),
    }
    continuation_sequence = {**common, "continuation": continuation}
    return {
        "full_color_aware": _canonical_sha256(full_key),
        "full_sequence_ignoring_color": _canonical_sha256(full_sequence),
        "continuation_color_aware": _canonical_sha256(continuation_with_slots),
        "continuation_ignoring_color": _canonical_sha256(continuation_sequence),
    }


def _score_for_a(record: Mapping[str, Any]) -> tuple[float | None, str]:
    if record.get("truncated") is True:
        return None, "TRUNCATED"
    winner = record.get("winner")
    if winner == "DRAW":
        return 0.5, "DRAW"
    if winner not in {Player.BLACK.value, Player.WHITE.value}:
        raise VerificationError(f"game has invalid winner {winner!r}")
    black_slot = record.get("black_slot")
    white_slot = record.get("white_slot")
    if (black_slot, white_slot) not in {("A", "B"), ("B", "A")}:
        raise VerificationError("game slots are not an A/B color assignment")
    a_color = Player.BLACK.value if black_slot == "A" else Player.WHITE.value
    return (1.0, "WIN") if winner == a_color else (0.0, "LOSS")


def _verify_game_against_plan(
    record: Mapping[str, Any],
    *,
    task: Mapping[str, Any],
    plan: Mapping[str, Any],
    manifest_sha256: str,
    runner_sha256: str,
    label: str,
) -> dict[str, Any]:
    required = (
        "experiment_id",
        "manifest_sha256",
        "protocol_sha256",
        "runner_sha256",
        "inference_group_id",
        "task_id",
        "game_id",
        "pair_id",
        "training_seed",
        "opening_cluster",
        "opening_id",
        "opening_seed",
        "opening_prefix_hash",
        "opening_state_hash",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
        "black_slot",
        "white_slot",
        "black_policy_seed",
        "white_policy_seed",
        "grid_size",
        "superko_mode",
        "truncated",
        "winner",
        "plies",
        "actions",
    )
    _require(record, required, label)
    if record["experiment_id"] != task["experiment_id"]:
        raise VerificationError(f"{label}: experiment id mismatch")
    if record["manifest_sha256"] != manifest_sha256:
        raise VerificationError(f"{label}: manifest hash mismatch")
    if record["protocol_sha256"] != task["protocol_sha256"]:
        raise VerificationError(f"{label}: protocol hash mismatch")
    _require_runner_binding(record, runner_sha256, label=label)
    if record["runner_sha256"] != task["runner_sha256"]:
        raise VerificationError(f"{label}: runner hash mismatch")
    if record["inference_group_id"] != task["inference_group_id"]:
        raise VerificationError(f"{label}: inference group mismatch")
    if record["task_id"] != task["task_id"]:
        raise VerificationError(f"{label}: task id mismatch")
    if record["training_seed"] != task["training_seed"]:
        raise VerificationError(f"{label}: training seed mismatch")
    if record["grid_size"] != task["eval_size"]:
        raise VerificationError(f"{label}: evaluation size mismatch")
    if record["superko_mode"] != task["superko_mode"]:
        raise VerificationError(f"{label}: Superko mode mismatch")
    if _integer(record["plies"], f"{label}.plies", minimum=0) > int(task["max_plies"]):
        raise VerificationError(f"{label}: trace exceeds max_plies")

    planned_games = _sequence(plan.get("_planned_games"), f"{label}.planned_games")
    planned_by_id = {str(game["game_id"]): game for game in planned_games}
    planned_game = planned_by_id.get(str(record["game_id"]))
    if planned_game is None:
        raise VerificationError(f"{label}: game id is absent from frozen game manifest")
    # These are experimental identity/randomness fields, not runtime outcomes.
    # Every one must be byte-for-byte equal to its pre-run game-manifest value.
    for field in (
        "experiment_id",
        "experiment_arm",
        "evidence_tier",
        "manifest_sha256",
        "materialized_manifest_sha256",
        "protocol_sha256",
        "runner_sha256",
        "task_id",
        "evaluation_kind",
        "inference_group_id",
        "game_id",
        "game_index",
        "pair_id",
        "pair_index",
        "pair_member",
        "pair_color_orientation",
        "color_swap",
        "black_slot",
        "white_slot",
        "training_seed",
        "checkpoint_id",
        "checkpoint_sha256",
        "config_hash",
        "source_hash",
        "checkpoint_bindings",
        "eval_size",
        "opponent",
        "model_pair",
        "opening_cluster",
        "opening_id",
        "opening_seed",
        "opening_prefix_hash",
        "opening_state_hash",
        "prefix_plies",
        "policy_seed_block",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
        "black_policy_seed",
        "white_policy_seed",
        "max_plies",
        "superko_mode",
        "source_hashes",
    ):
        if record.get(field) != planned_game.get(field):
            raise VerificationError(
                f"{label}: raw game differs from frozen game manifest at {field}"
            )

    _match_plan_field(
        record, plan, game_names=("pair_id",), plan_names=("pair_id",), label=label
    )
    _match_plan_field(
        record,
        plan,
        game_names=("opening_cluster",),
        plan_names=("opening_cluster",),
        label=label,
    )
    _match_plan_field(
        record,
        plan,
        game_names=("opening_id",),
        plan_names=("opening_id",),
        label=label,
    )
    _match_plan_field(
        record,
        plan,
        game_names=("opening_seed",),
        plan_names=("opening_seed",),
        label=label,
    )
    _match_plan_field(
        record,
        plan,
        game_names=("policy_seed_a",),
        plan_names=("policy_seed_a",),
        label=label,
    )
    _match_plan_field(
        record,
        plan,
        game_names=("policy_seed_b",),
        plan_names=("policy_seed_b",),
        label=label,
    )
    _match_plan_field(
        record,
        plan,
        game_names=("policy_seed_assignment",),
        plan_names=("policy_seed_assignment",),
        label=label,
    )
    raw_opening_actions = _first(
        record, "opening_prefix_actions", "opening_actions", default=None
    )
    if raw_opening_actions is None:
        raise VerificationError(f"{label}: raw game has no opening action prefix")
    opening_actions = _normalize_actions(
        raw_opening_actions, f"{label}.opening_prefix_actions"
    )
    plan_actions = _normalize_actions(
        plan["opening_actions"], f"{label}.plan.opening_actions"
    )
    if opening_actions != plan_actions:
        raise VerificationError(f"{label}: opening actions do not match pair plan")
    expected_prefix_hash = _opening_prefix_hash(opening_actions)
    if (
        record["opening_prefix_hash"] != expected_prefix_hash
        or plan["opening_prefix_hash"] != expected_prefix_hash
    ):
        raise VerificationError(f"{label}: opening prefix SHA-256 mismatch")
    expected_state_hash = _opening_state_hash(
        grid_size=int(task["eval_size"]),
        superko_mode=str(task["superko_mode"]),
        opening_actions=opening_actions,
    )
    if (
        record["opening_state_hash"] != expected_state_hash
        or plan["opening_state_hash"] != expected_state_hash
    ):
        raise VerificationError(f"{label}: opening state SHA-256 mismatch")

    actions = _sequence(record["actions"], f"{label}.actions")
    if len(actions) != record["plies"]:
        raise VerificationError(f"{label}: plies does not equal action count")
    for action_index in range(len(opening_actions)):
        diagnostics = _mapping(
            _mapping(actions[action_index], f"{label}.actions[{action_index}]").get(
                "diagnostics"
            ),
            f"{label}.actions[{action_index}].diagnostics",
        )
        if diagnostics.get("phase") != "opening_prefix":
            raise VerificationError(
                f"{label}: opening action {action_index} lacks diagnostics.phase=opening_prefix"
            )

    try:
        replay_game_record(dict(record))
    except Exception as exc:
        raise VerificationError(
            f"{label}: independent game replay failed: {exc}"
        ) from exc

    seed_a = int(record["policy_seed_a"])
    seed_b = int(record["policy_seed_b"])
    if record["black_slot"] == "A":
        expected_policy = (seed_a, seed_b)
    else:
        expected_policy = (seed_b, seed_a)
    if (record["black_policy_seed"], record["white_policy_seed"]) != expected_policy:
        raise VerificationError(
            f"{label}: black/white policy seeds do not follow A/B color swap"
        )

    score, outcome = _score_for_a(record)
    hashes = _trajectory_hashes(record, opening_actions)
    return {
        "record": record,
        "score": score,
        "outcome": outcome,
        "opening_actions": opening_actions,
        "trajectory_hashes": hashes,
    }


def _verify_pair(
    games: Sequence[dict[str, Any]],
    *,
    plan: Mapping[str, Any],
    label: str,
) -> float | None:
    if len(games) != 2:
        raise VerificationError(f"{label}: expected exactly two color-swapped games")
    left, right = games
    left_record = left["record"]
    right_record = right["record"]
    assignments = {
        (left_record.get("black_slot"), left_record.get("white_slot")),
        (right_record.get("black_slot"), right_record.get("white_slot")),
    }
    if assignments != {("A", "B"), ("B", "A")}:
        raise VerificationError(
            f"{label}: pair does not contain one A-black and one A-white game"
        )
    shared_fields = (
        "pair_id",
        "training_seed",
        "opening_cluster",
        "opening_id",
        "opening_seed",
        "opening_prefix_actions",
        "opening_prefix_hash",
        "opening_state_hash",
        "policy_seed_a",
        "policy_seed_b",
        "policy_seed_assignment",
    )
    for field in shared_fields:
        if left_record.get(field) != right_record.get(field):
            raise VerificationError(f"{label}: color pair disagrees on {field}")
    expected_game_ids = set(_plan_game_ids(plan))
    observed_game_ids = {left_record.get("game_id"), right_record.get("game_id")}
    if observed_game_ids != expected_game_ids:
        raise VerificationError(f"{label}: observed game IDs do not match pair plan")
    scores = [game["score"] for game in games]
    if any(score is None for score in scores):
        return None
    return statistics.fmean(float(score) for score in scores)


def _summary_counts(games: Sequence[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(game["outcome"] for game in games)
    return {
        "games_requested": len(games),
        "games_completed": len(games) - counts["TRUNCATED"],
        "truncated_games": counts["TRUNCATED"],
        "a_wins": counts["WIN"],
        "a_losses": counts["LOSS"],
        "draws": counts["DRAW"],
    }


def _verify_summary_artifact(
    summary_path: Path,
    *,
    recomputed: Mapping[str, int],
    label: str,
) -> None:
    summary = _mapping(load_json(summary_path), label)
    for field, value in recomputed.items():
        if summary.get(field) != value:
            raise VerificationError(f"{label}: {field} does not match raw games")


def _receipt_expected_hashes(
    task: Mapping[str, Any], receipt: Mapping[str, Any], runner_sha256: str
) -> int:
    verified = 0
    protocol_sha = task.get("protocol_sha256")
    if receipt.get("protocol_sha256") != protocol_sha or not _valid_sha256(
        protocol_sha
    ):
        raise VerificationError("receipt does not bind the frozen protocol SHA-256")
    _require_runner_binding(task, runner_sha256, label="task")
    _require_runner_binding(receipt, runner_sha256, label="receipt")
    if receipt.get("runner_sha256") != task.get("runner_sha256"):
        raise VerificationError("receipt does not bind the frozen runner SHA-256")
    execution_identity = _mapping(
        receipt.get("execution_identity"), "receipt.execution_identity"
    )
    experiments_path = Path(__file__).with_name("d17_d19_experiments.py")
    expected_execution_hashes = {
        "runner_sha256": runner_sha256,
        "experiments_sha256": _sha256_file(experiments_path),
        "protocol_sha256": protocol_sha,
    }
    for field, expected in expected_execution_hashes.items():
        if execution_identity.get(field) != expected:
            raise VerificationError(f"receipt execution identity mismatch for {field}")
        verified += 1
    _verify_receipt_checkpoint_bindings(task, receipt)
    for direct_field, nested_field in (
        ("checkpoint_sha256", "sha256"),
        ("config_hash", "config_hash"),
        ("source_hash", "source_hash"),
    ):
        expected = _collect_named_values(task.get(direct_field), direct_field)
        if isinstance(task.get(direct_field), str):
            expected.add(str(task[direct_field]))
        elif isinstance(task.get(direct_field), list):
            expected.update(str(value) for value in task[direct_field])
        expected.update(
            _all_values_for_key(task.get("checkpoint_bindings"), nested_field)
        )
        observed = _collect_named_values(receipt.get(direct_field), direct_field)
        if isinstance(receipt.get(direct_field), str):
            observed.add(str(receipt[direct_field]))
        elif isinstance(receipt.get(direct_field), list):
            observed.update(str(value) for value in receipt[direct_field])
        observed.update(
            _all_values_for_key(receipt.get("checkpoint_bindings"), nested_field)
        )
        observed.update(
            _all_values_for_key(receipt.get("agent_bindings"), nested_field)
        )
        if expected and not expected.issubset(observed):
            raise VerificationError(
                f"receipt does not bind all task {direct_field} values"
            )
        if expected:
            verified += len(expected)
    task_sources = _mapping(task.get("source_hashes"), "task.source_hashes")
    receipt_sources = receipt.get("source_hashes")
    if receipt_sources != task_sources:
        raise VerificationError("receipt source_hashes do not match the frozen task")
    _verify_source_files(task_sources, label="task.source_hashes")
    verified += len(task_sources)
    verified += _verify_checkpoint_paths(task, label="task")
    verified += _verify_checkpoint_paths(receipt, label="receipt")
    return verified


def _audit_task(
    *,
    task: Mapping[str, Any],
    receipt: Mapping[str, Any],
    manifest_sha256: str,
    runner_sha256: str,
    task_manifest_sha256: str,
    game_manifest_sha256: str,
    receipts_base: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], int]:
    task_id = str(task["task_id"])
    if receipt.get("task_id") != task_id:
        raise VerificationError(f"{task_id}: receipt task id mismatch")
    if receipt.get("experiment_id") != task["experiment_id"]:
        raise VerificationError(f"{task_id}: receipt experiment id mismatch")
    if receipt.get("manifest_sha256") != manifest_sha256:
        raise VerificationError(f"{task_id}: receipt manifest hash mismatch")
    if receipt.get("task_manifest_sha256") != task_manifest_sha256:
        raise VerificationError(f"{task_id}: receipt task-manifest hash mismatch")
    if receipt.get("game_manifest_sha256") != game_manifest_sha256:
        raise VerificationError(f"{task_id}: receipt game-manifest hash mismatch")
    if receipt.get("status") != "complete":
        reason = receipt.get("failure_reason")
        raise VerificationError(f"{task_id}: task status is not complete: {reason!r}")

    games_path_value, games_digest = _artifact_field(receipt, "games")
    games_path = _validate_file_binding(
        games_path_value,
        games_digest,
        base=receipts_base,
        label=f"{task_id}.games",
    )
    raw_games = load_jsonl(games_path)
    expected_games = int(task["games"])
    if len(raw_games) != expected_games:
        raise VerificationError(
            f"{task_id}: raw game count is {len(raw_games)}, expected {expected_games}"
        )

    plans = _task_pair_plan(task, task_id)
    plan_by_id = {str(plan["pair_id"]): plan for plan in plans}
    audited_games: list[dict[str, Any]] = []
    by_pair: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_game_ids: set[str] = set()
    for index, record in enumerate(raw_games):
        pair_id = _string(record.get("pair_id"), f"{task_id}.games[{index}].pair_id")
        plan = plan_by_id.get(pair_id)
        if plan is None:
            raise VerificationError(f"{task_id}: unplanned pair id {pair_id!r}")
        audited = _verify_game_against_plan(
            record,
            task=task,
            plan=plan,
            manifest_sha256=manifest_sha256,
            runner_sha256=runner_sha256,
            label=f"{task_id}.games[{index}]",
        )
        game_id = _string(record.get("game_id"), f"{task_id}.games[{index}].game_id")
        if game_id in seen_game_ids:
            raise VerificationError(f"{task_id}: duplicate raw game id {game_id!r}")
        seen_game_ids.add(game_id)
        audited_games.append(audited)
        by_pair[pair_id].append(audited)

    planned_game_ids = {game_id for plan in plans for game_id in _plan_game_ids(plan)}
    if seen_game_ids != planned_game_ids:
        missing = len(planned_game_ids - seen_game_ids)
        extra = len(seen_game_ids - planned_game_ids)
        raise VerificationError(
            f"{task_id}: planned/raw game IDs differ ({missing=} {extra=})"
        )

    pair_rows: list[dict[str, Any]] = []
    for plan in plans:
        pair_id = str(plan["pair_id"])
        pair_score = _verify_pair(
            by_pair.get(pair_id, []), plan=plan, label=f"{task_id}.{pair_id}"
        )
        pair_rows.append(
            {
                "task_id": task_id,
                "experiment_id": task["experiment_id"],
                "experiment_arm": task["experiment_arm"],
                "inference_group_id": task["inference_group_id"],
                "training_seed": task["training_seed"],
                "opening_cluster": plan["opening_cluster"],
                "opening_id": plan["opening_id"],
                "crossed_cluster_id": (
                    str(plan["opening_cluster"])
                    if task["experiment_id"] == D16_V2_ID
                    else str(plan.get("policy_seed_block", plan["pair_id"]))
                    + f".x{plan['policy_seed_assignment']}"
                ),
                "pair_id": pair_id,
                "pair_score": pair_score,
            }
        )

    counts = _summary_counts(audited_games)
    receipt_counts = {
        "games_requested": _receipt_count(
            receipt, "games_requested", "requested_games"
        ),
        "games_completed": _receipt_count(
            receipt, "games_completed", "completed_games"
        ),
        "truncated_games": _receipt_count(
            receipt, "truncated_games", "games_truncated"
        ),
        "a_wins": _receipt_count(receipt, "a_wins", "wins"),
        "a_losses": _receipt_count(receipt, "a_losses", "losses"),
        "draws": _receipt_count(receipt, "draws"),
    }
    if receipt_counts != counts:
        raise VerificationError(
            f"{task_id}: receipt W/D/L or completion counts disagree with raw games"
        )
    if receipt.get("replay_verified_games") != counts["games_requested"]:
        raise VerificationError(
            f"{task_id}: receipt replay count does not cover every game"
        )

    summary_path_value, summary_digest = _artifact_field(receipt, "summary")
    if summary_path_value is not None:
        summary_path = _validate_file_binding(
            summary_path_value,
            summary_digest,
            base=receipts_base,
            label=f"{task_id}.summary",
        )
        _verify_summary_artifact(
            summary_path, recomputed=counts, label=f"{task_id}.summary"
        )

    hash_bindings_verified = _receipt_expected_hashes(task, receipt, runner_sha256)
    full_hashes = {
        game["trajectory_hashes"]["full_color_aware"] for game in audited_games
    }
    full_sequence_hashes = {
        game["trajectory_hashes"]["full_sequence_ignoring_color"]
        for game in audited_games
    }
    continuation_hashes = {
        game["trajectory_hashes"]["continuation_ignoring_color"]
        for game in audited_games
    }
    continuation_by_cluster: dict[str, set[str]] = defaultdict(set)
    for game in audited_games:
        cluster = str(game["record"]["opening_cluster"])
        continuation_by_cluster[cluster].add(
            game["trajectory_hashes"]["continuation_ignoring_color"]
        )
    diverse_clusters = sum(
        len(values)
        >= MIN_CONTINUATIONS_PER_DIVERSE_CLUSTER.get(task["experiment_id"], 1)
        for values in continuation_by_cluster.values()
    )

    declared_unique = _first(
        receipt,
        "unique_action_trajectories",
        "unique_full_trajectories",
        default=None,
    )
    if declared_unique is not None and declared_unique != len(full_sequence_hashes):
        raise VerificationError(f"{task_id}: receipt unique trajectory count mismatch")

    task_row = {
        "task_id": task_id,
        "experiment_id": task["experiment_id"],
        "experiment_arm": task["experiment_arm"],
        "inference_group_id": task["inference_group_id"],
        "training_seed": task["training_seed"],
        "eval_size": task["eval_size"],
        **counts,
        "pairs_verified": len(pair_rows),
        "opening_clusters": len(continuation_by_cluster),
        "unique_full_color_aware": len(full_hashes),
        "unique_full_sequence_ignoring_color": len(full_sequence_hashes),
        "unique_continuation_ignoring_opening_and_color": len(continuation_hashes),
        "clusters_with_minimum_continuation_diversity": diverse_clusters,
        "hash_bindings_verified": hash_bindings_verified,
    }
    return task_row, audited_games, pair_rows, hash_bindings_verified


def _t_critical_975(df: int) -> float:
    table = {
        1: 12.706,
        2: 4.303,
        3: 3.182,
        4: 2.776,
        5: 2.571,
        6: 2.447,
        7: 2.365,
        8: 2.306,
        9: 2.262,
        10: 2.228,
        11: 2.201,
        12: 2.179,
        13: 2.160,
        14: 2.145,
        15: 2.131,
        16: 2.120,
        17: 2.110,
        18: 2.101,
        19: 2.093,
        20: 2.086,
        21: 2.080,
        22: 2.074,
        23: 2.069,
        24: 2.064,
        25: 2.060,
        26: 2.056,
        27: 2.052,
        28: 2.048,
        29: 2.045,
        30: 2.042,
    }
    if df < 1:
        raise VerificationError("a t interval requires at least two statistical units")
    return table.get(df, 1.96)


def _seed_t_interval(seed_scores: Sequence[float]) -> list[float] | None:
    if len(seed_scores) < 2:
        return None
    mean = statistics.fmean(seed_scores)
    standard_error = statistics.stdev(seed_scores) / math.sqrt(len(seed_scores))
    margin = _t_critical_975(len(seed_scores) - 1) * standard_error
    return [max(0.0, mean - margin), min(1.0, mean + margin)]


def _percentile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise VerificationError("cannot take a percentile of an empty sample")
    ordered = sorted(values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _crossed_cluster_bootstrap_interval(
    clusters_by_seed: Mapping[int, Mapping[str, Sequence[float]]],
    *,
    resamples: int,
    random_seed: int,
) -> list[float] | None:
    seeds = sorted(clusters_by_seed)
    if len(seeds) < 2 or resamples < 1:
        return None
    cluster_sets = [set(clusters_by_seed[seed]) for seed in seeds]
    if not cluster_sets or any(
        clusters != cluster_sets[0] for clusters in cluster_sets[1:]
    ):
        raise VerificationError(
            "crossed-cluster bootstrap requires the same registered cluster IDs for every seed"
        )
    cluster_ids = sorted(cluster_sets[0])
    if not cluster_ids:
        return None
    rng = random.Random(random_seed)
    estimates: list[float] = []
    for _ in range(resamples):
        sampled_seeds = [rng.choice(seeds) for _ in range(len(seeds))]
        sampled_clusters = [rng.choice(cluster_ids) for _ in range(len(cluster_ids))]
        crossed_cells = [
            statistics.fmean(clusters_by_seed[seed][cluster])
            for seed in sampled_seeds
            for cluster in sampled_clusters
        ]
        estimates.append(statistics.fmean(crossed_cells))
    return [_percentile(estimates, 0.025), _percentile(estimates, 0.975)]


def _pooled_wilson_descriptive(wins: int, draws: int, games: int) -> list[float] | None:
    if games < 1:
        return None
    proportion = (wins + 0.5 * draws) / games
    z = 1.96
    denominator = 1.0 + z * z / games
    center = (proportion + z * z / (2.0 * games)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1.0 - proportion) / games + z * z / (4.0 * games * games)
        )
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def _bootstrap_settings(manifest: Mapping[str, Any]) -> dict[str, tuple[int, int]]:
    statistics_config = manifest.get("statistics")
    if not isinstance(statistics_config, Mapping):
        raise VerificationError("manifest.statistics is missing")
    gen = _mapping(
        statistics_config.get("gen_size_secondary_interval"),
        "manifest.statistics.gen_size_secondary_interval",
    )
    d16 = _mapping(
        statistics_config.get("d16_v2_primary_interval"),
        "manifest.statistics.d16_v2_primary_interval",
    )
    observed = {
        GEN_SIZE_ID: (
            _integer(
                gen.get("replicates"), "GEN-SIZE bootstrap replicates", minimum=2_000
            ),
            _integer(gen.get("bootstrap_seed"), "GEN-SIZE bootstrap seed", minimum=0),
        ),
        D16_V2_ID: (
            _integer(
                d16.get("replicates"), "D16-v2 bootstrap replicates", minimum=2_000
            ),
            _integer(d16.get("bootstrap_seed"), "D16-v2 bootstrap seed", minimum=0),
        ),
    }
    if observed != FROZEN_BOOTSTRAP_SETTINGS:
        raise VerificationError(
            "manifest bootstrap replicates/seeds differ from the frozen protocol: "
            f"observed={observed}, expected={FROZEN_BOOTSTRAP_SETTINGS}"
        )
    return dict(FROZEN_BOOTSTRAP_SETTINGS)


def _aggregate_groups(
    *,
    task_rows: Sequence[Mapping[str, Any]],
    games: Sequence[Mapping[str, Any]],
    pairs: Sequence[Mapping[str, Any]],
    bootstrap_settings: Mapping[str, tuple[int, int]],
    manifest_sha256: str,
) -> list[dict[str, Any]]:
    tasks_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    games_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    pairs_by_group: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in task_rows:
        tasks_by_group[str(row["inference_group_id"])].append(row)
    for game in games:
        games_by_group[str(game["inference_group_id"])].append(game)
    for pair in pairs:
        pairs_by_group[str(pair["inference_group_id"])].append(pair)

    rows: list[dict[str, Any]] = []
    for group_id in sorted(tasks_by_group):
        group_tasks = tasks_by_group[group_id]
        group_games = games_by_group[group_id]
        group_pairs = pairs_by_group[group_id]
        experiment_ids = {str(row["experiment_id"]) for row in group_tasks}
        if len(experiment_ids) != 1:
            raise VerificationError(f"inference group {group_id!r} mixes experiments")
        experiment_id = next(iter(experiment_ids))
        seeds = sorted({int(row["training_seed"]) for row in group_tasks})

        clusters_by_seed: dict[int, dict[str, list[float]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for pair in group_pairs:
            score = pair["pair_score"]
            if score is None:
                continue
            clusters_by_seed[int(pair["training_seed"])][
                str(pair["crossed_cluster_id"])
            ].append(float(score))
        seed_scores: list[float] = []
        seed_unit_rows: list[dict[str, Any]] = []
        cluster_unit_count = 0
        for seed in seeds:
            clusters = clusters_by_seed.get(seed, {})
            cluster_scores = {
                cluster: statistics.fmean(values)
                for cluster, values in sorted(clusters.items())
                if values
            }
            cluster_unit_count += len(cluster_scores)
            if cluster_scores:
                seed_score = statistics.fmean(cluster_scores.values())
                seed_scores.append(seed_score)
                seed_unit_rows.append(
                    {
                        "training_seed": seed,
                        "opening_clusters": len(cluster_scores),
                        "seed_score_equal_weighted_over_clusters": seed_score,
                    }
                )

        outcomes = Counter(str(game["outcome"]) for game in group_games)
        completed = len(group_games) - outcomes["TRUNCATED"]
        full_hashes = {
            str(game["trajectory_hashes"]["full_color_aware"]) for game in group_games
        }
        sequence_hashes = {
            str(game["trajectory_hashes"]["full_sequence_ignoring_color"])
            for game in group_games
        }
        continuation_hashes = {
            str(game["trajectory_hashes"]["continuation_ignoring_color"])
            for game in group_games
        }
        bootstrap_resamples, frozen_seed = bootstrap_settings[experiment_id]
        # The protocol freezes one literal RNG seed per arm.  Do not derive a
        # group-specific seed from the manifest or group id: doing so would
        # silently change the preregistered bootstrap and would also prevent
        # matched groups from sharing the same resampling indices.
        random_seed = frozen_seed
        seed_ci = _seed_t_interval(seed_scores)
        crossed_ci = _crossed_cluster_bootstrap_interval(
            clusters_by_seed,
            resamples=bootstrap_resamples,
            random_seed=random_seed,
        )
        if experiment_id == GEN_SIZE_ID:
            primary_method = "training-seed Student t interval"
            primary_ci = seed_ci
            secondary_method = "two-way crossed seed x policy-pair bootstrap"
            secondary_ci = crossed_ci
        else:
            primary_method = "two-way crossed seed x opening-cluster bootstrap"
            primary_ci = crossed_ci
            secondary_method = "training-seed Student t interval"
            secondary_ci = seed_ci
        rows.append(
            {
                "inference_group_id": group_id,
                "experiment_id": experiment_id,
                "experiment_arm": group_tasks[0]["experiment_arm"],
                "task_receipts": len(group_tasks),
                "training_seed_units": len(seed_scores),
                "seed_by_opening_cluster_units": cluster_unit_count,
                "paired_color_units": len(group_pairs),
                "games_completed": completed,
                "truncated_games": outcomes["TRUNCATED"],
                "a_wins": outcomes["WIN"],
                "a_losses": outcomes["LOSS"],
                "draws": outcomes["DRAW"],
                "unique_full_color_aware": len(full_hashes),
                "unique_full_sequence_ignoring_color": len(sequence_hashes),
                "unique_continuation_ignoring_opening_and_color": len(
                    continuation_hashes
                ),
                "primary_score_equal_weighted_over_training_seeds": (
                    statistics.fmean(seed_scores) if seed_scores else None
                ),
                "training_seed_t_ci95": seed_ci,
                "crossed_seed_cluster_bootstrap_ci95": crossed_ci,
                "primary_interval_method": primary_method,
                "primary_ci95": primary_ci,
                "secondary_interval_method": secondary_method,
                "secondary_ci95": secondary_ci,
                "crossed_cluster_bootstrap_resamples": bootstrap_resamples,
                "crossed_cluster_bootstrap_seed": random_seed,
                "pooled_game_score_descriptive_only": (
                    (outcomes["WIN"] + 0.5 * outcomes["DRAW"]) / completed
                    if completed
                    else None
                ),
                "pooled_game_wilson_ci95_descriptive_only": _pooled_wilson_descriptive(
                    outcomes["WIN"], outcomes["DRAW"], completed
                ),
                "seed_units": seed_unit_rows,
            }
        )
    return rows


def _numeric_core(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema_name": value.get("schema_name"),
        "schema_version": value.get("schema_version"),
        "bundle_id": value.get("bundle_id"),
        "manifest_sha256": value.get("manifest_sha256"),
        "protocol_sha256": value.get("protocol_sha256"),
        "runner_sha256": value.get("runner_sha256"),
        "experiments_sha256": value.get("experiments_sha256"),
        "task_manifest_sha256": value.get("task_manifest_sha256"),
        "game_manifest_sha256": value.get("game_manifest_sha256"),
        "comparison_rows": value.get("comparison_rows"),
    }


def _numeric_equal(left: Any, right: Any, *, path: str = "$") -> None:
    if isinstance(left, Mapping):
        if not isinstance(right, Mapping) or set(left) != set(right):
            raise VerificationError(
                f"canonical numeric mismatch at {path}: object keys differ"
            )
        for key in left:
            _numeric_equal(left[key], right[key], path=f"{path}.{key}")
        return
    if isinstance(left, list):
        if not isinstance(right, list) or len(left) != len(right):
            raise VerificationError(
                f"canonical numeric mismatch at {path}: array length differs"
            )
        for index, (left_item, right_item) in enumerate(zip(left, right)):
            _numeric_equal(left_item, right_item, path=f"{path}[{index}]")
        return
    if isinstance(left, (int, float)) and not isinstance(left, bool):
        if isinstance(right, bool) or not isinstance(right, (int, float)):
            raise VerificationError(
                f"canonical numeric mismatch at {path}: type differs"
            )
        if not math.isclose(float(left), float(right), rel_tol=1e-12, abs_tol=1e-12):
            raise VerificationError(
                f"canonical numeric mismatch at {path}: {left!r} != {right!r}"
            )
        return
    if left != right:
        raise VerificationError(
            f"canonical numeric mismatch at {path}: {left!r} != {right!r}"
        )


def _validate_ledger_status(
    *,
    ledger_status_path: Path,
    receipts_path: Path,
    manifest_sha256: str,
    protocol_sha256: str,
    runner_sha256: str,
    task_manifest_sha256: str,
    game_manifest_sha256: str,
    receipts: Sequence[Mapping[str, Any]],
) -> None:
    status = _mapping(load_json(ledger_status_path), str(ledger_status_path))
    declared_ledger_hash = _first(
        status,
        "ledger_sha256",
        "result_receipts_sha256",
        "receipts_sha256",
        default=None,
    )
    if declared_ledger_hash != _sha256_file(receipts_path):
        raise VerificationError("ledger status does not bind result_receipts.jsonl")
    if status.get("manifest_sha256") != manifest_sha256:
        raise VerificationError("ledger status manifest SHA-256 mismatch")
    if status.get("protocol_sha256") != protocol_sha256:
        raise VerificationError("ledger status protocol SHA-256 mismatch")
    if status.get("runner_sha256") != runner_sha256:
        raise VerificationError("ledger status runner SHA-256 mismatch")
    if status.get("experiments_sha256") != _sha256_file(
        Path(__file__).with_name("d17_d19_experiments.py")
    ):
        raise VerificationError("ledger status experiments SHA-256 mismatch")
    if status.get("task_manifest_sha256") != task_manifest_sha256:
        raise VerificationError("ledger status task-manifest SHA-256 mismatch")
    if status.get("game_manifest_sha256") != game_manifest_sha256:
        raise VerificationError("ledger status game-manifest SHA-256 mismatch")
    declared_count = _first(
        status, "receipt_count", "total_receipts", "tasks_recorded", default=None
    )
    if declared_count != len(receipts):
        raise VerificationError("ledger status receipt count mismatch")
    gate_failed_ids: list[str] = []
    for index, receipt in enumerate(receipts):
        gate_status = receipt.get("gate_status")
        if gate_status not in {"passed", "failed"}:
            raise VerificationError(
                f"ledger receipt {index} has an invalid gate status"
            )
        if gate_status == "failed":
            gate_failed_ids.append(
                _string(receipt.get("task_id"), f"receipts[{index}].task_id")
            )
    if status.get("gate_failed_tasks") != len(gate_failed_ids):
        raise VerificationError(
            "ledger status gate-failure count disagrees with audited receipts"
        )
    if status.get("gate_failed_preview") != gate_failed_ids[:10]:
        raise VerificationError(
            "ledger status gate-failure preview disagrees with audited receipts"
        )


def _unique_gate(task_row: Mapping[str, Any]) -> bool:
    experiment_id = str(task_row["experiment_id"])
    # Slot labels are excluded from the formal diversity key.  The color-aware
    # hash is retained only as a supplementary audit count.
    if (
        task_row["unique_full_sequence_ignoring_color"]
        < MIN_UNIQUE_FULL_BY_TASK[experiment_id]
    ):
        return False
    if experiment_id == D16_V2_ID:
        if (
            task_row["unique_continuation_ignoring_opening_and_color"]
            < MIN_UNIQUE_CONTINUATIONS_BY_TASK[experiment_id]
        ):
            return False
        if (
            task_row["opening_clusters"]
            != EXPECTED_OPENING_CLUSTERS_PER_TASK[experiment_id]
        ):
            return False
        if (
            task_row["clusters_with_minimum_continuation_diversity"]
            < MIN_DIVERSE_CLUSTERS_BY_TASK[experiment_id]
        ):
            return False
    return True


def _validate_receipt_gate_declaration(
    receipt: Mapping[str, Any], *, expected_passed: bool, label: str
) -> bool:
    formal_gate = _mapping(receipt.get("formal_gate"), f"{label}.formal_gate")
    if formal_gate.get("passed") is not expected_passed:
        raise VerificationError(
            f"{label}: receipt formal gate disagrees with independent recomputation"
        )
    expected_status = "passed" if expected_passed else "failed"
    if receipt.get("gate_status") != expected_status:
        raise VerificationError(
            f"{label}: receipt gate status disagrees with independent recomputation"
        )
    expected_reason = None if expected_passed else "formal_task_gate_failed"
    if receipt.get("failure_reason") != expected_reason:
        raise VerificationError(f"{label}: receipt gate failure reason is inconsistent")
    return not expected_passed


def _verify_export_tree_binding(
    *, receipts_base: Path, expected_tree_sha256: str
) -> int:
    manifest_path = _resolve_artifact_path(
        "export_manifest.json",
        base=receipts_base,
        label="canonical export manifest",
    )
    manifest = _mapping(load_json(manifest_path), str(manifest_path))
    if set(manifest) != {
        "schema_name",
        "schema_version",
        "source_run_root",
        "files",
        "pair_scratch_exported",
        "created_at_utc",
    }:
        raise VerificationError("canonical export manifest fields are invalid")
    if (
        manifest.get("schema_name") != "lifeline-d17-d19-lightweight-export"
        or manifest.get("schema_version") != 1
        or manifest.get("pair_scratch_exported") is not False
    ):
        raise VerificationError("canonical export manifest identity is invalid")
    _string(manifest.get("source_run_root"), "export manifest.source_run_root")
    created_at = _string(
        manifest.get("created_at_utc"), "export manifest.created_at_utc"
    )
    if (
        re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", created_at)
        is None
    ):
        raise VerificationError("canonical export manifest timestamp is invalid")
    entries = _sequence(manifest.get("files"), "export manifest.files")
    if len(entries) != EXPECTED_EXPORT_MANIFEST_ENTRIES:
        raise VerificationError("canonical export manifest entry count mismatch")
    tree_rows: list[dict[str, str]] = []
    observed_relatives: set[str] = set()
    marker = f"/{BUNDLE_ID}/"
    for index, raw_entry in enumerate(entries):
        entry = _mapping(raw_entry, f"export manifest.files[{index}]")
        if set(entry) != {"path", "sha256"}:
            raise VerificationError(
                f"export manifest.files[{index}] has invalid fields"
            )
        remote_path = _string(entry.get("path"), f"export manifest.files[{index}].path")
        normalized = remote_path.replace("\\", "/")
        if marker not in normalized:
            raise VerificationError(
                f"export manifest.files[{index}] is outside the frozen bundle"
            )
        relative = normalized.rsplit(marker, 1)[1]
        parts = relative.split("/")
        if not parts or any(part in ("", ".", "..") for part in parts):
            raise VerificationError(
                f"export manifest.files[{index}] has an unsafe relative path"
            )
        relative = "/".join(parts)
        if relative in observed_relatives:
            raise VerificationError(
                "canonical export manifest contains duplicate paths"
            )
        observed_relatives.add(relative)
        declared = entry.get("sha256")
        if not _valid_sha256(declared):
            raise VerificationError(
                f"export manifest.files[{index}] has an invalid SHA-256"
            )
        local_path = _resolve_artifact_path(
            relative,
            base=receipts_base,
            label=f"export manifest.files[{index}]",
        )
        actual = _sha256_file(local_path)
        if actual != str(declared).lower():
            raise VerificationError(
                f"export manifest.files[{index}] payload hash mismatch"
            )
        tree_rows.append({"path": relative, "sha256": actual})
    top_level = {
        "execution_metadata.json",
        "execution_summary.json",
        "result_ledger_status.json",
        "result_receipts.jsonl",
    }
    task_artifacts = observed_relatives - top_level
    if (
        not top_level.issubset(observed_relatives)
        or len(task_artifacts) != EXPECTED_EXPORT_MANIFEST_ENTRIES - len(top_level)
        or any(
            not relative.startswith("tasks/")
            or relative.rsplit("/", 1)[-1]
            not in {"receipt.json", "summary.json", "games.jsonl"}
            for relative in task_artifacts
        )
    ):
        raise VerificationError("canonical export manifest payload matrix is invalid")
    observed_tree_sha256 = _canonical_sha256(tree_rows)
    if observed_tree_sha256 != expected_tree_sha256:
        raise VerificationError("canonical export payload-tree hash mismatch")
    return len(tree_rows)


def _canonical_derivation_binding(
    *,
    canonical_numeric_path: Path,
    canonical_receipt_path: Path,
    cli_sha256: str | None,
    receipts_base: Path,
    expected_bindings: Mapping[str, str],
    expected_gate_failed_tasks: int,
) -> tuple[str, dict[str, Any]]:
    receipt = _mapping(load_json(canonical_receipt_path), str(canonical_receipt_path))
    expected_receipt_fields = {
        "schema_name",
        "schema_version",
        "bundle_id",
        "status",
        "formal_ready",
        "formal_source_hash",
        "independent_numeric_consumed",
        "read_only_inputs",
        "frozen_runner_canonical_aggregate_reused",
        "input_fingerprint_before_aggregate_sha256",
        "input_fingerprint_after_aggregate_sha256",
        "created_at_utc",
        "outputs",
        "bindings",
        "counts",
        "claims",
    }
    if set(receipt) != expected_receipt_fields:
        raise VerificationError("canonical derivation receipt fields are incomplete")
    if receipt.get("schema_name") != "lifeline-d17-d19-canonical-derivation-receipt":
        raise VerificationError("canonical hash source has the wrong receipt schema")
    if receipt.get("schema_version") != 1 or receipt.get("bundle_id") != BUNDLE_ID:
        raise VerificationError("canonical derivation receipt identity mismatch")
    if (
        receipt.get("status")
        != "canonical_numeric_recovered_awaiting_independent_verification"
        or receipt.get("formal_ready") is not False
        or receipt.get("independent_numeric_consumed") is not False
        or receipt.get("read_only_inputs") is not True
        or receipt.get("frozen_runner_canonical_aggregate_reused") is not True
    ):
        raise VerificationError("canonical derivation receipt state is not admissible")
    created_at = _string(
        receipt.get("created_at_utc"), "canonical receipt.created_at_utc"
    )
    if (
        re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", created_at)
        is None
    ):
        raise VerificationError("canonical derivation receipt timestamp is invalid")
    before = receipt.get("input_fingerprint_before_aggregate_sha256")
    after = receipt.get("input_fingerprint_after_aggregate_sha256")
    if not _valid_sha256(before) or after != before:
        raise VerificationError(
            "canonical derivation receipt input snapshot is not stable"
        )
    outputs = _mapping(receipt.get("outputs"), "canonical receipt.outputs")
    declared_name = _string(
        outputs.get("canonical_numeric"),
        "canonical receipt.outputs.canonical_numeric",
    )
    if Path(declared_name).name != declared_name:
        raise VerificationError("canonical derivation receipt output name is not local")
    declared_path = _resolve_artifact_path(
        declared_name,
        base=canonical_receipt_path.parent,
        label="canonical receipt.outputs.canonical_numeric",
    )
    canonical_resolved = _resolve_artifact_path(
        canonical_numeric_path.name,
        base=canonical_numeric_path.parent,
        label="canonical numeric input",
    )
    if declared_path != canonical_resolved:
        raise VerificationError(
            "canonical numeric path differs from its derivation receipt output"
        )
    declared_sha256 = outputs.get("canonical_numeric_sha256")
    if not _valid_sha256(declared_sha256):
        raise VerificationError(
            "canonical derivation receipt declares an invalid SHA-256"
        )
    declared_sha256 = str(declared_sha256).lower()

    bindings = _mapping(receipt.get("bindings"), "canonical receipt.bindings")
    if set(bindings) != CANONICAL_RECEIPT_BINDING_FIELDS:
        raise VerificationError("canonical derivation receipt bindings are incomplete")
    if any(not _valid_sha256(value) for value in bindings.values()):
        raise VerificationError(
            "canonical derivation receipt contains an invalid binding"
        )
    formal_source_hash = receipt.get("formal_source_hash")
    if (
        not _valid_sha256(formal_source_hash)
        or bindings.get("formal_source_hash") != formal_source_hash
    ):
        raise VerificationError("canonical formal source hash binding is invalid")
    for field, expected in expected_bindings.items():
        if bindings.get(field) != expected:
            raise VerificationError(
                f"canonical derivation receipt binding mismatch for {field}"
            )
    adapter_path = Path(__file__).with_name("d17_d19_build_canonical_from_export.py")
    if bindings.get("adapter_sha256") != _sha256_file(adapter_path):
        raise VerificationError("canonical derivation receipt adapter hash mismatch")
    for field, filename in (
        ("export_manifest_sha256", "export_manifest.json"),
        ("execution_metadata_sha256", "execution_metadata.json"),
        ("result_ledger_status_sha256", "result_ledger_status.json"),
        ("execution_summary_sha256", "execution_summary.json"),
    ):
        bound_path = _resolve_artifact_path(
            filename,
            base=receipts_base,
            label=f"canonical receipt.bindings.{field}",
        )
        if bindings.get(field) != _sha256_file(bound_path):
            raise VerificationError(
                f"canonical derivation receipt binding mismatch for {field}"
            )
    export_tree_entries = _verify_export_tree_binding(
        receipts_base=receipts_base,
        expected_tree_sha256=str(bindings["export_payload_tree_sha256"]).lower(),
    )

    counts = _mapping(receipt.get("counts"), "canonical receipt.counts")
    if set(counts) != CANONICAL_RECEIPT_COUNT_FIELDS:
        raise VerificationError("canonical derivation receipt counts are incomplete")
    for field, value in counts.items():
        _integer(value, f"canonical receipt.counts.{field}", minimum=0)
    expected_counts = {
        "task_receipts": sum(EXPECTED_TASKS.values()),
        "task_summaries": sum(EXPECTED_TASKS.values()),
        "task_game_files": sum(EXPECTED_TASKS.values()),
        "game_rows": sum(
            EXPECTED_TASKS[experiment_id] * EXPECTED_GAMES_PER_TASK[experiment_id]
            for experiment_id in EXPECTED_TASKS
        ),
        "complete_tasks": sum(EXPECTED_TASKS.values()),
        "gate_failed_tasks": expected_gate_failed_tasks,
        "comparison_rows": sum(EXPECTED_GROUPS.values()),
    }
    if any(counts.get(field) != value for field, value in expected_counts.items()):
        raise VerificationError("canonical derivation receipt formal counts mismatch")
    if (
        counts["export_manifest_entries"] != export_tree_entries
        or counts["export_payload_files"] != export_tree_entries
        or counts["fingerprinted_input_files"] < counts["export_payload_files"]
        or counts["stable_input_roles"] != counts["fingerprinted_input_files"]
    ):
        raise VerificationError(
            "canonical derivation receipt fingerprint counts mismatch"
        )

    claims = _mapping(receipt.get("claims"), "canonical receipt.claims")
    if claims != {
        "execution_complete": True,
        "formal_task_gates_all_passed": expected_gate_failed_tasks == 0,
        "independent_verification_passed": False,
        "publication_ready": False,
    }:
        raise VerificationError("canonical derivation receipt claims are inadmissible")
    if cli_sha256 is not None:
        if not _valid_sha256(cli_sha256):
            raise VerificationError("--canonical-sha256 is invalid")
        if str(cli_sha256).lower() != declared_sha256:
            raise VerificationError(
                "--canonical-sha256 disagrees with the canonical derivation receipt"
            )
    return declared_sha256, {
        "type": "canonical_derivation_receipt",
        "path": str(canonical_receipt_path.resolve()),
        "receipt_sha256": _sha256_file(canonical_receipt_path),
        "field": "outputs.canonical_numeric_sha256",
        "producer_input_fingerprint_sha256": str(before).lower(),
        "producer_adapter_sha256": str(bindings["adapter_sha256"]).lower(),
        "formal_source_hash": str(formal_source_hash).lower(),
    }


def _verification_allowlisted_roots(
    *,
    manifest_path: Path,
    task_manifest_path: Path | None,
    game_manifest_path: Path,
    receipts_path: Path,
    ledger_status_path: Path | None,
    canonical_numeric_path: Path | None,
    canonical_receipt_path: Path | None,
) -> dict[str, Path]:
    def parent_for(path: Path, *, label: str) -> Path:
        if _contains_parent_reference(Path(path)):
            raise VerificationError(
                f"{label}: parent path components are forbidden in top-level input"
            )
        return Path(os.path.abspath(path)).parent

    roots: dict[str, Path] = {
        "repository": REPOSITORY_ROOT,
        "manifest_input": parent_for(manifest_path, label="manifest_input"),
        "formal_run_export": parent_for(receipts_path, label="receipts_input"),
    }
    task_parents = {
        parent_for(path, label=label)
        for label, path in (
            ("task_manifest_input", task_manifest_path),
            ("game_manifest_input", game_manifest_path),
        )
        if path is not None
    }
    if len(task_parents) != 1:
        raise VerificationError(
            "task manifest and game manifest must share one explicit task-bundle root"
        )
    roots["task_bundle"] = next(iter(task_parents))
    export_root = roots["formal_run_export"]
    if (
        ledger_status_path is not None
        and parent_for(ledger_status_path, label="ledger_status_input") != export_root
    ):
        raise VerificationError(
            "ledger status must be inside the formal-run export root"
        )
    canonical_paths = tuple(
        path
        for path in (canonical_numeric_path, canonical_receipt_path)
        if path is not None
    )
    if canonical_paths:
        canonical_parents = {
            parent_for(path, label="canonical_producer_input")
            for path in canonical_paths
        }
        if len(canonical_parents) != 1:
            raise VerificationError(
                "canonical numeric and receipt must share one producer root"
            )
        roots["canonical_producer"] = next(iter(canonical_parents))
    return roots


def _paths_overlap(first: Path, second: Path) -> bool:
    try:
        first.relative_to(second)
        return True
    except ValueError:
        pass
    try:
        second.relative_to(first)
        return True
    except ValueError:
        return False


def _future_resolved_path(path: Path, *, label: str) -> Path:
    """Resolve existing ancestry without creating any missing component."""

    absolute = Path(os.path.abspath(path))
    missing: list[str] = []
    current = absolute
    while not os.path.lexists(current):
        if current == current.parent:
            raise VerificationError(f"{label}: path has no existing filesystem anchor")
        missing.append(current.name)
        current = current.parent
    _reject_reparse_ancestry(current, label=label)
    try:
        resolved = current.resolve(strict=True)
    except OSError as exc:
        raise VerificationError(f"{label}: cannot resolve existing ancestry") from exc
    for component in reversed(missing):
        resolved /= component
    return resolved


def _reject_output_input_overlap(
    output_directory: Path, roots: Mapping[str, Path]
) -> None:
    output_lexical = Path(os.path.abspath(output_directory))
    output_resolved = _future_resolved_path(
        output_lexical, label="verification output path"
    )
    for root_id, root in roots.items():
        if root_id == "repository":
            continue
        root_lexical = Path(os.path.abspath(root))
        root_resolved = _future_resolved_path(
            root_lexical, label=f"verification input root {root_id!r}"
        )
        if _paths_overlap(output_lexical, root_lexical) or _paths_overlap(
            output_resolved, root_resolved
        ):
            raise VerificationError(
                "verification output must be disjoint from immutable input root "
                f"{root_id!r}: {root_lexical}"
            )


def verify_evidence(
    *,
    manifest_path: Path,
    task_manifest_path: Path | None,
    game_manifest_path: Path,
    receipts_path: Path,
    ledger_status_path: Path | None,
    canonical_numeric_path: Path | None,
    canonical_sha256: str | None,
    canonical_receipt_path: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Verify one stable allowlisted input snapshot and return report/numeric data."""

    global _ACTIVE_INPUT_SNAPSHOT
    if _ACTIVE_INPUT_SNAPSHOT is not None:
        raise VerificationError("nested verifier input snapshots are forbidden")
    if canonical_numeric_path is not None and canonical_receipt_path is None:
        canonical_receipt_path = (
            canonical_numeric_path.parent / "canonical_derivation_receipt.json"
        )
    roots = _verification_allowlisted_roots(
        manifest_path=manifest_path,
        task_manifest_path=task_manifest_path,
        game_manifest_path=game_manifest_path,
        receipts_path=receipts_path,
        ledger_status_path=ledger_status_path,
        canonical_numeric_path=canonical_numeric_path,
        canonical_receipt_path=canonical_receipt_path,
    )
    snapshot = _InputSnapshot(roots)
    _ACTIVE_INPUT_SNAPSHOT = snapshot
    try:
        report, numeric = _verify_evidence_snapshot(
            manifest_path=manifest_path,
            task_manifest_path=task_manifest_path,
            game_manifest_path=game_manifest_path,
            receipts_path=receipts_path,
            ledger_status_path=ledger_status_path,
            canonical_numeric_path=canonical_numeric_path,
            canonical_sha256=canonical_sha256,
            canonical_receipt_path=canonical_receipt_path,
        )
        report["closure_input_fingerprint"] = snapshot.verify_unchanged()
        return report, numeric
    finally:
        _ACTIVE_INPUT_SNAPSHOT = None


def _verify_evidence_snapshot(
    *,
    manifest_path: Path,
    task_manifest_path: Path | None,
    game_manifest_path: Path,
    receipts_path: Path,
    ledger_status_path: Path | None,
    canonical_numeric_path: Path | None,
    canonical_sha256: str | None,
    canonical_receipt_path: Path | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build the independent report and numeric interface from an active snapshot."""

    gates = {name: False for name in GATE_NAMES}
    issues: list[str] = []
    runner_sha256 = _sha256_file(Path(__file__).with_name("d17_d19_runner.py"))
    manifest = _mapping(load_json(manifest_path), str(manifest_path))
    _validate_manifest_identity(manifest)
    checkpoint_registry = _manifest_checkpoint_registry(manifest)
    readonly_bindings_verified = _verify_readonly_bindings(manifest)
    runtime_source_hashes = _mapping(
        manifest.get("source_hashes"), "manifest.source_hashes"
    )
    _verify_source_files(runtime_source_hashes, label="manifest.source_hashes")
    _load_lifeline_runtime(runtime_source_hashes)
    manifest_sha256 = _canonical_sha256(manifest)
    gates["manifest_valid"] = True
    gates["new_experiment_ids"] = True
    bootstrap_settings = _bootstrap_settings(manifest)

    task_rows, task_manifest_sha256 = _manifest_task_rows(manifest, task_manifest_path)
    game_manifest_rows = load_jsonl(game_manifest_path)
    game_manifest_sha256 = _sha256_file(game_manifest_path)
    task_rows = _attach_game_manifest(task_rows, game_manifest_rows, runner_sha256)
    if task_manifest_sha256 is None:
        raise VerificationError("task manifest SHA-256 could not be established")
    tasks_by_id = _validate_task_rows(
        task_rows,
        manifest_sha256,
        str(manifest["protocol_sha256"]),
        runner_sha256,
        checkpoint_registry,
    )
    gates["task_manifest_complete"] = True
    gates["task_pair_plans_explicit"] = True

    receipts, ledger_rows = _load_receipt_ledger(receipts_path)
    by_task: dict[str, Mapping[str, Any]] = {}
    duplicate_receipts: set[str] = set()
    for index, receipt in enumerate(receipts):
        task_id = _string(receipt.get("task_id"), f"receipts[{index}].task_id")
        if task_id in by_task:
            duplicate_receipts.add(task_id)
        by_task[task_id] = receipt
    expected_ids = set(tasks_by_id)
    observed_ids = set(by_task)
    if duplicate_receipts:
        issues.append(f"duplicate receipts: {sorted(duplicate_receipts)}")
    if expected_ids != observed_ids:
        issues.append(
            f"receipt task set mismatch: missing={len(expected_ids - observed_ids)}, "
            f"extra={len(observed_ids - expected_ids)}"
        )
    else:
        gates["receipt_ledger_complete"] = not duplicate_receipts

    if ledger_status_path is not None:
        try:
            _validate_ledger_status(
                ledger_status_path=ledger_status_path,
                receipts_path=receipts_path,
                manifest_sha256=manifest_sha256,
                protocol_sha256=str(manifest["protocol_sha256"]),
                runner_sha256=runner_sha256,
                task_manifest_sha256=task_manifest_sha256,
                game_manifest_sha256=game_manifest_sha256,
                receipts=receipts,
            )
            gates["ledger_status_bound"] = True
        except VerificationError as exc:
            issues.append(str(exc))
    else:
        issues.append("ledger status was not supplied")

    task_audits: list[dict[str, Any]] = []
    all_games: list[dict[str, Any]] = []
    all_pairs: list[dict[str, Any]] = []
    failed_tasks: list[dict[str, str]] = []
    verified_gate_failures: list[bool] = []
    total_hash_bindings = 0
    for task_id in sorted(expected_ids & observed_ids):
        task = tasks_by_id[task_id]
        receipt = by_task[task_id]
        if receipt.get("status") != "complete":
            failed_tasks.append(
                {
                    "task_id": task_id,
                    "reason": str(receipt.get("failure_reason", "status failed")),
                }
            )
            continue
        try:
            task_row, audited_games, pair_rows, hash_count = _audit_task(
                task=task,
                receipt=receipt,
                manifest_sha256=manifest_sha256,
                runner_sha256=runner_sha256,
                task_manifest_sha256=task_manifest_sha256,
                game_manifest_sha256=game_manifest_sha256,
                receipts_base=receipts_path.parent,
            )
            gate_failed = _validate_receipt_gate_declaration(
                receipt,
                expected_passed=_unique_gate(task_row),
                label=f"receipt {task_id}",
            )
            verified_gate_failures.append(gate_failed)
            task_audits.append(task_row)
            for game in audited_games:
                game["inference_group_id"] = task["inference_group_id"]
                game["experiment_id"] = task["experiment_id"]
                game["training_seed"] = task["training_seed"]
            all_games.extend(audited_games)
            all_pairs.extend(pair_rows)
            total_hash_bindings += hash_count
        except VerificationError as exc:
            failed_tasks.append({"task_id": task_id, "reason": str(exc)})

    if not failed_tasks and len(task_audits) == len(tasks_by_id):
        gates["no_failed_tasks"] = True
        gates["no_missing_or_extra_games"] = True
        gates["all_games_replayed"] = True
        gates["receipt_counts_recomputed"] = True
        gates["checkpoint_source_config_hashes_bound"] = total_hash_bindings > 0
        gates["protocol_runner_hashes_bound"] = total_hash_bindings > 0
        gates["opening_prefixes_bound"] = True
        gates["policy_seeds_bound"] = True
        gates["paired_colors_complete"] = True
        gates["pair_identity_combinations_unique"] = True
    else:
        issues.extend(f"{item['task_id']}: {item['reason']}" for item in failed_tasks)

    gates["no_truncated_games"] = (
        bool(task_audits)
        and all(row["truncated_games"] == 0 for row in task_audits)
        and len(task_audits) == len(tasks_by_id)
    )
    gates["unique_trajectory_thresholds_met"] = (
        bool(task_audits)
        and all(_unique_gate(row) for row in task_audits)
        and len(task_audits) == len(tasks_by_id)
    )

    # Opening IDs are intentionally reused across model comparisons.  Their
    # seed/actions/hashes must identify one immutable opening everywhere.
    opening_registry: dict[tuple[str, int, str], tuple[Any, ...]] = {}
    opening_reuse: Counter[tuple[str, int, str]] = Counter()
    try:
        for task in task_rows:
            for plan in _task_pair_plan(task, str(task["task_id"])):
                key = (
                    str(task["experiment_id"]),
                    int(task["eval_size"]),
                    str(plan["opening_id"]),
                )
                identity = (
                    plan["opening_seed"],
                    tuple(
                        _normalize_actions(plan["opening_actions"], "opening_actions")
                    ),
                    plan["opening_prefix_hash"],
                    plan["opening_state_hash"],
                )
                prior = opening_registry.setdefault(key, identity)
                if prior != identity:
                    raise VerificationError(f"opening registry drift for {key}")
                opening_reuse[key] += 1
        d16_keys = [key for key in opening_registry if key[0] == D16_V2_ID]
        if not d16_keys or any(opening_reuse[key] < 2 for key in d16_keys):
            raise VerificationError("D16-v2 openings are not reused across model tasks")
        gates["opening_registry_reused"] = True
    except VerificationError as exc:
        issues.append(str(exc))

    group_rows: list[dict[str, Any]] = []
    if task_audits:
        try:
            group_rows = _aggregate_groups(
                task_rows=task_audits,
                games=all_games,
                pairs=all_pairs,
                bootstrap_settings=bootstrap_settings,
                manifest_sha256=manifest_sha256,
            )
            group_counts = Counter(row["experiment_id"] for row in group_rows)
            seeds_ok = all(
                row["training_seed_units"] == EXPECTED_TRAINING_SEEDS_PER_GROUP
                for row in group_rows
            )
            gates["statistical_units_valid"] = (
                dict(group_counts) == EXPECTED_GROUPS and seeds_ok
            )
            gates["seed_t_intervals_computed"] = seeds_ok and all(
                row["training_seed_t_ci95"] is not None for row in group_rows
            )
            gates["crossed_cluster_intervals_computed"] = seeds_ok and all(
                row["crossed_seed_cluster_bootstrap_ci95"] is not None
                for row in group_rows
            )
        except VerificationError as exc:
            issues.append(str(exc))

    numeric = {
        "schema_name": NUMERIC_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": BUNDLE_ID,
        "manifest_sha256": manifest_sha256,
        "protocol_sha256": manifest["protocol_sha256"],
        "runner_sha256": runner_sha256,
        "experiments_sha256": _sha256_file(
            Path(__file__).with_name("d17_d19_experiments.py")
        ),
        "task_manifest_sha256": task_manifest_sha256,
        "game_manifest_sha256": game_manifest_sha256,
        "comparison_rows": group_rows,
    }

    # Independence boundary: canonical content is loaded only after the full
    # independent numeric object above has been computed from raw records.
    canonical_details: dict[str, Any] = {
        "path": None,
        "expected_sha256": None,
        "actual_sha256": None,
        "numeric_match": False,
        "hash_source": None,
    }
    if canonical_numeric_path is not None:
        try:
            if canonical_receipt_path is None:
                raise VerificationError("canonical derivation receipt was not supplied")
            if len(verified_gate_failures) != len(tasks_by_id):
                raise VerificationError(
                    "canonical gate-failure count cannot be derived from every task"
                )
            receipt_source_hashes = {receipt.get("source_hash") for receipt in receipts}
            if len(receipt_source_hashes) != 1 or not _valid_sha256(
                next(iter(receipt_source_hashes))
            ):
                raise VerificationError(
                    "formal receipts do not identify one formal source hash"
                )
            receipt_source_hash = str(next(iter(receipt_source_hashes))).lower()
            expected_canonical_hash, hash_source = _canonical_derivation_binding(
                canonical_numeric_path=canonical_numeric_path,
                canonical_receipt_path=canonical_receipt_path,
                cli_sha256=canonical_sha256,
                receipts_base=receipts_path.parent,
                expected_bindings={
                    "runner_sha256": runner_sha256,
                    "experiments_sha256": numeric["experiments_sha256"],
                    "manifest_file_sha256": _sha256_file(manifest_path),
                    "manifest_canonical_sha256": manifest_sha256,
                    "protocol_sha256": str(manifest["protocol_sha256"]),
                    "task_manifest_sha256": task_manifest_sha256,
                    "game_manifest_sha256": game_manifest_sha256,
                    "result_ledger_sha256": _sha256_file(receipts_path),
                    "formal_source_hash": receipt_source_hash,
                },
                expected_gate_failed_tasks=sum(verified_gate_failures),
            )
            gates["canonical_derivation_receipt_bound"] = True
            actual_canonical_hash = _sha256_file(canonical_numeric_path)
            canonical_details.update(
                {
                    "path": str(canonical_numeric_path.resolve()),
                    "expected_sha256": expected_canonical_hash,
                    "actual_sha256": actual_canonical_hash,
                    "hash_source": hash_source,
                }
            )
            if actual_canonical_hash != expected_canonical_hash:
                raise VerificationError("canonical numeric file SHA-256 mismatch")
            gates["canonical_hash_verified"] = True
            canonical = _mapping(
                load_json(canonical_numeric_path), str(canonical_numeric_path)
            )
            _numeric_equal(_numeric_core(numeric), _numeric_core(canonical))
            gates["canonical_numeric_match"] = True
            canonical_details["numeric_match"] = True
        except VerificationError as exc:
            issues.append(str(exc))
    else:
        issues.append("canonical numeric interface was not supplied")

    formal_ready = all(gates.values())
    report = {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": BUNDLE_ID,
        "formal_ready": formal_ready,
        "status": "PASS" if formal_ready else "FAIL_CLOSED",
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "inputs": {
            "manifest": {
                "path": str(manifest_path.resolve()),
                "file_sha256": _sha256_file(manifest_path),
                "canonical_sha256": manifest_sha256,
            },
            "task_manifest": {
                "path": str(task_manifest_path.resolve())
                if task_manifest_path
                else "embedded",
                "sha256": task_manifest_sha256,
            },
            "game_manifest": {
                "path": str(game_manifest_path.resolve()),
                "sha256": game_manifest_sha256,
                "rows": len(game_manifest_rows),
            },
            "receipts": {
                "path": str(receipts_path.resolve()),
                "sha256": _sha256_file(receipts_path),
                "ledger_rows": len(ledger_rows),
            },
            "ledger_status": (
                {
                    "path": str(ledger_status_path.resolve()),
                    "sha256": _sha256_file(ledger_status_path),
                }
                if ledger_status_path is not None and ledger_status_path.is_file()
                else None
            ),
            "canonical_numeric": canonical_details,
        },
        "gates": gates,
        "issues": issues,
        "task_counts": {
            "expected": len(tasks_by_id),
            "receipts": len(receipts),
            "independently_verified": len(task_audits),
            "failed_or_invalid": len(failed_tasks),
            "missing": len(expected_ids - observed_ids),
            "extra": len(observed_ids - expected_ids),
        },
        "game_counts": {
            "raw_records_replayed": len(all_games),
            "truncated": sum(row["truncated_games"] for row in task_audits),
            "paired_color_units": len(all_pairs),
        },
        "trajectory_counts": {
            "unique_full_color_aware": len(
                {game["trajectory_hashes"]["full_color_aware"] for game in all_games}
            ),
            "unique_full_sequence_ignoring_color": len(
                {
                    game["trajectory_hashes"]["full_sequence_ignoring_color"]
                    for game in all_games
                }
            ),
            "unique_continuation_ignoring_opening_and_color": len(
                {
                    game["trajectory_hashes"]["continuation_ignoring_color"]
                    for game in all_games
                }
            ),
        },
        "statistical_methods": {
            "primary_unit_gen_size": "training_seed",
            "primary_unit_d16_v2": "training_seed x opening_cluster",
            "color_handling": "two color-swapped games are averaged into one paired unit",
            "gen_size_primary_interval": (
                "two-sided 95% Student t interval over five training-seed means"
            ),
            "gen_size_secondary_interval": (
                "two-way crossed training-seed x shared policy-pair percentile bootstrap"
            ),
            "d16_v2_primary_interval": (
                "two-way crossed training-seed x shared opening-cluster percentile bootstrap"
            ),
            "d16_v2_secondary_interval": (
                "two-sided 95% Student t interval over five training-seed means"
            ),
            "crossed_cluster_resampling": (
                "deterministic two-way crossed-cluster percentile bootstrap: independently "
                "resample shared training-seed IDs and shared opening/policy-pair IDs, then "
                "take their Cartesian cells without treating individual games as independent"
            ),
            "bootstrap_settings": {
                experiment_id: {"replicates": values[0], "frozen_seed": values[1]}
                for experiment_id, values in bootstrap_settings.items()
            },
            "pooled_game_wilson": "descriptive only; never used by a formal-ready gate",
        },
        "task_audits": task_audits,
        "comparison_rows": group_rows,
        "failed_tasks": failed_tasks,
        "verifier_sha256": _sha256_file(Path(__file__).resolve()),
        "runtime_code": {
            "manifest_source_binding_sha256": _RUNTIME_SOURCE_BINDING,
            "verifier_runtime_dependency_binding_sha256": (_RUNTIME_DEPENDENCY_BINDING),
            "verifier_runtime_dependency_source_sha256": dict(
                sorted(VERIFIER_RUNTIME_SOURCE_HASHES.items())
            ),
            "execution_mode": "authenticated_source_bytes_no_bytecode",
            "loaded_file_sha256": dict(_RUNTIME_FILE_BINDINGS),
        },
        "readonly_bindings_verified": readonly_bindings_verified,
    }
    return report, numeric


def _failure_report(exc: Exception, *, manifest_path: Path) -> dict[str, Any]:
    return {
        "schema_name": REPORT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "bundle_id": BUNDLE_ID,
        "formal_ready": False,
        "status": "FAIL_CLOSED",
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "inputs": {"manifest": str(manifest_path.resolve())},
        "gates": {name: False for name in GATE_NAMES},
        "issues": [str(exc)],
        "verifier_sha256": _sha256_file(Path(__file__).resolve()),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--task-manifest",
        type=Path,
        help="explicit frozen task JSONL/JSON; omit only when tasks are embedded",
    )
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--game-manifest", type=Path, required=True)
    parser.add_argument("--ledger-status", type=Path)
    parser.add_argument("--canonical-numeric", type=Path)
    parser.add_argument(
        "--canonical-receipt",
        type=Path,
        help=(
            "producer derivation receipt; defaults to canonical_derivation_receipt.json "
            "beside --canonical-numeric"
        ),
    )
    parser.add_argument("--canonical-sha256")
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        input_roots = _verification_allowlisted_roots(
            manifest_path=args.manifest,
            task_manifest_path=args.task_manifest,
            game_manifest_path=args.game_manifest,
            receipts_path=args.receipts,
            ledger_status_path=args.ledger_status,
            canonical_numeric_path=args.canonical_numeric,
            canonical_receipt_path=args.canonical_receipt,
        )
        _reject_output_input_overlap(args.output_dir, input_roots)
        output_target = _prepare_new_output_directory(args.output_dir)
        output_dir, _, _ = output_target
    except Exception as exc:
        print(
            f"ERROR: cannot prepare fresh verification directory: {exc}",
            file=sys.stderr,
        )
        return 2
    publication: dict[str, Any] | None = None
    try:
        report, numeric = verify_evidence(
            manifest_path=args.manifest,
            task_manifest_path=args.task_manifest,
            game_manifest_path=args.game_manifest,
            receipts_path=args.receipts,
            ledger_status_path=args.ledger_status,
            canonical_numeric_path=args.canonical_numeric,
            canonical_sha256=args.canonical_sha256,
            canonical_receipt_path=args.canonical_receipt,
        )
        publication = _publish_output_pair(
            output_directory=output_dir,
            numeric=numeric,
            report=report,
            expected_target=output_target,
        )
        _validate_publication(publication)
    except Exception as exc:  # fail-closed artifact is intentional
        failure_cause: Exception = exc
        if publication is not None and os.path.lexists(output_dir):
            try:
                quarantine = _quarantine_publication(publication)
            except Exception as quarantine_exc:
                failure_cause = VerificationError(
                    f"{exc}; could not quarantine invalid output: {quarantine_exc}"
                )
            else:
                failure_cause = VerificationError(
                    f"{exc}; invalid output was quarantined at {quarantine}"
                )
        report = _failure_report(failure_cause, manifest_path=args.manifest)
        try:
            failure_publication = _publish_failure_report(
                output_directory=output_dir,
                report=report,
                expected_target=output_target,
            )
            _validate_publication(failure_publication)
        except Exception as publish_exc:
            report["issues"].append(
                f"could not publish exclusive failure report directory: {publish_exc}"
            )
        print(
            json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    return 0 if report["formal_ready"] is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
