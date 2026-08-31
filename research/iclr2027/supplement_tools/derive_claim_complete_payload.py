from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

import build_supplement_candidate as builder  # noqa: E402
import subject_binding  # noqa: E402


STATUS = builder.STATUS
APPROVAL = "author_approval_required"
SCHEMA_VERSION = 1
DERIVED_PREFIX = "research/iclr2027/supplement_tools/derived_claim_complete/"
CLAIM_IDS = tuple(f"C{index}" for index in range(1, 11))
HEX64_RE = re.compile(r"[0-9a-f]{64}")
CLAIM_PACKAGE_NAME = "lifeline_rl_claim_complete_candidate"
CLAIM_PURPOSE = (
    "anonymous C1-C10 code, protocol, aggregate, and verifier review candidate"
)
CLAIM_MAX_FILE_BYTES = 1_048_576
CLAIM_MAX_TOTAL_BYTES = 8_388_608
GAME_ENGINE_SOURCE = "web/web\u524d\u7aef/GameEngine.js"
REQUIRED_DERIVED_MODES = frozenset(
    {
        "claim_ledger",
        "d14_protocol",
        "compact_ledger",
        "ledger_status",
        "superko_config",
        "superko_verification",
        "environment_receipt",
        "terminology_erratum",
        "game_engine_copy",
        "reference_trace",
        "derivation_receipt",
    }
)
PROHIBITED_EXTENSION_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9_])D(?:17|18|19)(?![A-Za-z0-9_])"
)
FORMAL_INPUT_PREFIX = "research/iclr2027/results/formal/"
CLAIM_COMPLETE_FORMAL_INPUT_EXCEPTIONS = frozenset(
    {
        *builder.CLAIM_COMPLETE_FORMAL_SOURCE_EXCEPTIONS,
        "research/iclr2027/results/formal/d14_d16/run_v1/result_ledger_status.json",
        "research/iclr2027/results/formal/d14_d16/run_v1/result_receipts.jsonl",
    }
)
CLAIM_COMPLETE_CHECKPOINT_INPUT_EXCEPTIONS = frozenset(
    builder.CLAIM_COMPLETE_CHECKPOINT_EXCEPTIONS["source"]
)
SUPERKO_CONFIG_SOURCE_KEYS = frozenset(
    {
        "schema_version",
        "experiment",
        "formal_config",
        "source_sha256",
        "checkpoint",
        "retry_lineage",
        "attempt2_preflight",
        "verification",
        "checkpoint_provenance",
        "expected_receipt",
    }
)
SUPERKO_CHECKPOINT_SOURCE_KEYS = frozenset(
    {"path", "sha256", "config_hash", "source_hash"}
)
SUPERKO_VERIFICATION_SOURCE_KEYS = frozenset(
    {
        "schema_version",
        "experiment",
        "attempt_id",
        "status",
        "purpose",
        "conditions_verified",
        "blocks_verified",
        "games_replayed",
        "orientations_verified",
        "actions_replayed",
        "checkpoint_files_verified",
        "checkpoint_file_verification_skipped",
        "formal_sidecars_verified",
        "formal_sidecar_verification_skipped",
        "positive_control_passed",
        "runtime_seconds",
        "completed_at_utc",
        "json_finite",
        "source_files_matched",
        "source_files_expected",
        "artifacts",
        "verifier_command",
        "claim_boundary",
    }
)
ENVIRONMENT_RECEIPT_SOURCE_KEYS = frozenset(
    {
        "errors",
        "formal_execution_metadata",
        "hardware_note",
        "lock",
        "observed",
        "ok",
        "schema_name",
        "schema_version",
        "verifier",
    }
)
ENVIRONMENT_LOCK_PATH = "research/iclr2027/requirements-d14-d16-win-cu118.lock.txt"
ENVIRONMENT_METADATA_PATH = (
    "research/iclr2027/results/validation/"
    "d14_d16_execution_metadata_portable_20260831.json"
)
ENVIRONMENT_VERIFIER_PATH = "research/iclr2027/scripts/verify_d14_d16_environment.py"
ENVIRONMENT_RECEIPT_PATH = (
    "research/iclr2027/results/validation/"
    "d14_d16_environment_verification_20260831_v2.json"
)

CLAIM_LEDGER_CLAIM_REWRITES = {
    "C4": (
        "The formal bundle is complete at its declared scope: 15 training tasks, "
        "315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 "
        "unique replay-verified arena games.",
        "The formal bundle is complete at its declared scope: 15 training tasks, "
        "315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 "
        "task-indexed replay-verified game records.",
    ),
    "C5": (
        "At the final checkpoint, every model--size cell beats Random on jointly "
        "trained sizes 5, 7, and 9.",
        "All 45 final training-seed scores against Random exceed 0.5 on jointly "
        "trained sizes 5, 7, and 9.",
    ),
    "C6": (
        "Against UCT-MCTS-16, seven cells are clear under the descriptive Wilson "
        "summary, Padded-CNN at side five is borderline, and Grid-GNN at side five "
        "is inconclusive.",
        "Against UCT-MCTS-16, five-seed cell medians and ranges vary by model and "
        "size, with cell medians spanning 0.477 to 0.920.",
    ),
    "C7": (
        "Topology-GNN's pooled direct-play score exceeds Grid-GNN's at sides 5, 7, "
        "and 9 in this run.",
        "Direct-play training-seed summaries are heterogeneous: only Topology-GNN "
        "versus Grid-GNN at side 7 has median 1.0; the other eight cells have "
        "median 0.5, with wide ranges and no global ordering.",
    ),
}
CLAIM_LEDGER_LIMITATION_REWRITES = {
    "C5": (
        "These are pooled descriptive score rates on seen sizes. They do not "
        "establish zero-shot size generalization or independent-game inference.",
        "These are descriptive summaries over five training seeds on seen sizes; "
        "they do not establish zero-shot size generalization or independent-game "
        "inference.",
    ),
    "C6": (
        "The intervals are descriptive, not multiplicity-adjusted hypothesis tests. "
        "Search strength is fixed at 16 simulations.",
        "The five-seed summaries are descriptive, with no confidence intervals or "
        "hypothesis tests; search strength is fixed at 16 simulations.",
    ),
    "C7": (
        "Each 200-game task contains only two color-conditioned trajectories. "
        "Size-dependent reversals against Padded-CNN rule out a global "
        "representation ranking.",
        "Each 200-game task contains only two color-conditioned trajectories; the "
        "five-seed summaries are descriptive, ranges are wide, and no global "
        "representation ordering is supported.",
    ),
}
CLAIM_LEDGER_SEED_AUDIT_PATH = "reviews/d14_d16_seed_pair_descriptive_audit.json"
CLAIM_LEDGER_EVIDENCE_ADDITIONS = {
    "C5": CLAIM_LEDGER_SEED_AUDIT_PATH,
    "C6": CLAIM_LEDGER_SEED_AUDIT_PATH,
    "C7": CLAIM_LEDGER_SEED_AUDIT_PATH,
}
CLAIM_LEDGER_EVIDENCE_PATH_REWRITES = (
    (
        "results/formal/d14_d16/run_v1/result_ledger_status.json",
        "results/compact/d14_d16/d14_d16_ledger_status.anonymized.json",
    ),
    (
        "results/formal/d14_d16/run_v1/result_receipts.jsonl",
        "results/compact/d14_d16/d14_d16_compact_receipts.jsonl",
    ),
    (
        "D14_D16_EXPERIMENT_PROTOCOL.md",
        "D14_D16_EXPERIMENT_PROTOCOL.anonymized.md",
    ),
    (
        "results/validation/superko_policy_matrix_five_seed_v1_attempt2_verification.json",
        "results/validation/superko_policy_matrix_attempt2_verification.anonymized.json",
    ),
)
CLAIM_LEDGER_NON_PATH_EVIDENCE = frozenset(
    {
        "frozen environment/search test suite",
        "targeted and seeded parity receipts",
        "independent verifier receipts",
        "9,000 color-balanced games against Random",
        "9,000 color-balanced games against UCT-MCTS-16",
        "Figure 2",
    }
)
CLAIM_LEDGER_PATH_CLAUSE_RE = re.compile(r"^`([^`]+)`$")

RECEIPT_FIELDS = (
    "schema_name",
    "schema_version",
    "experiment_id",
    "task_id",
    "result_kind",
    "status",
    "evidence_tier",
    "seed",
    "representation",
    "board_sizes",
    "train_sizes",
    "eval_size",
    "checkpoint_gradient_steps",
    "self_play_games_completed",
    "gradient_steps_completed",
    "environment_steps_completed",
    "games_requested",
    "games_completed",
    "replay_verified_games",
    "truncated_games",
    "a_wins",
    "a_losses",
    "draws",
    "a_as_black_games",
    "a_as_white_games",
    "color_pairs_verified",
    "parameter_count",
    "superko_mode",
    "manifest_sha256",
)


class DerivationError(RuntimeError):
    """Fail-closed claim-complete payload derivation error."""


@dataclass(frozen=True)
class ProfileEntry:
    source: str
    destination: str
    category: str
    mode: str
    inputs: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class ClaimCompleteProfile:
    entries: tuple[ProfileEntry, ...]
    descriptive_only_destinations: tuple[str, ...]
    raw_sha256: str


@dataclass(frozen=True)
class TransformContract:
    source: str
    destination: str
    category: str
    input_paths: tuple[str, ...]


TRANSFORM_CONTRACTS: Mapping[str, TransformContract] = {
    "reference_trace": TransformContract(
        DERIVED_PREFIX + "reference_trace.mjs",
        "research/iclr2027/scripts/reference_trace.mjs",
        "reproducibility_runner",
        ("research/iclr2027/scripts/reference_trace.mjs",),
    ),
    "game_engine_copy": TransformContract(
        DERIVED_PREFIX + "GameEngine.js",
        "web/GameEngine.js",
        "independent_reference",
        (GAME_ENGINE_SOURCE,),
    ),
    "claim_ledger": TransformContract(
        DERIVED_PREFIX + "CLAIM_EVIDENCE_LIMITATION.admitted.json",
        "research/iclr2027/CLAIM_EVIDENCE_LIMITATION.admitted.json",
        "admitted_claim_ledger",
        ("research/iclr2027/CLAIM_EVIDENCE_LIMITATION.md",),
    ),
    "d14_protocol": TransformContract(
        DERIVED_PREFIX + "D14_D16_EXPERIMENT_PROTOCOL.anonymized.md",
        "research/iclr2027/D14_D16_EXPERIMENT_PROTOCOL.anonymized.md",
        "frozen_protocol_derivative",
        ("research/iclr2027/D14_D16_EXPERIMENT_PROTOCOL.md",),
    ),
    "compact_ledger": TransformContract(
        DERIVED_PREFIX + "d14_d16_compact_receipts.jsonl",
        "research/iclr2027/results/compact/d14_d16/d14_d16_compact_receipts.jsonl",
        "compact_receipt_ledger",
        ("research/iclr2027/results/formal/d14_d16/run_v1/result_receipts.jsonl",),
    ),
    "ledger_status": TransformContract(
        DERIVED_PREFIX + "d14_d16_ledger_status.anonymized.json",
        "research/iclr2027/results/compact/d14_d16/d14_d16_ledger_status.anonymized.json",
        "compact_receipt_status",
        ("research/iclr2027/results/formal/d14_d16/run_v1/result_ledger_status.json",),
    ),
    "superko_config": TransformContract(
        DERIVED_PREFIX + "superko_policy_matrix_v1_attempt2.anonymized.json",
        "research/iclr2027/configs/superko_policy_matrix_v1_attempt2.anonymized.json",
        "frozen_config_derivative",
        ("research/iclr2027/configs/superko_policy_matrix_v1_attempt2_manifest.json",),
    ),
    "superko_verification": TransformContract(
        DERIVED_PREFIX + "superko_policy_matrix_attempt2_verification.anonymized.json",
        "research/iclr2027/results/validation/"
        "superko_policy_matrix_attempt2_verification.anonymized.json",
        "verifier_receipt_derivative",
        (
            "research/iclr2027/results/validation/"
            "superko_policy_matrix_five_seed_v1_attempt2_verification.json",
        ),
    ),
    "environment_receipt": TransformContract(
        DERIVED_PREFIX + "d14_d16_environment_verification.anonymized.json",
        "research/iclr2027/results/validation/"
        "d14_d16_environment_verification.anonymized.json",
        "environment_receipt_derivative",
        (
            "research/iclr2027/results/validation/"
            "d14_d16_environment_verification_20260831_v2.json",
        ),
    ),
    "terminology_erratum": TransformContract(
        DERIVED_PREFIX + "D14_D16_TERMINOLOGY_ERRATUM.anonymized.md",
        "research/iclr2027/D14_D16_TERMINOLOGY_ERRATUM.anonymized.md",
        "claim_boundary_derivative",
        ("research/iclr2027/D14_D16_TERMINOLOGY_ERRATUM.md",),
    ),
    "derivation_receipt": TransformContract(
        DERIVED_PREFIX + "ANONYMIZATION_DERIVATION.json",
        "research/iclr2027/results/validation/ANONYMIZATION_DERIVATION.json",
        "transformation_receipt",
        (),
    ),
}

if frozenset(TRANSFORM_CONTRACTS) != REQUIRED_DERIVED_MODES:
    raise RuntimeError("transform contract table does not match required derived modes")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        rendered = json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise DerivationError("canonical JSON value is not serializable") from exc
    return (rendered + "\n").encode("utf-8")


def _pretty_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise DerivationError("JSON output value is not serializable") from exc


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is forbidden: {value}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, child in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key is forbidden: {key!r}")
        value[key] = child
    return value


def _reject_nonfinite_numbers(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite JSON number is forbidden")
    if isinstance(value, dict):
        for child in value.values():
            _reject_nonfinite_numbers(child)
    elif isinstance(value, list):
        for child in value:
            _reject_nonfinite_numbers(child)


def _strict_json_loads(data: bytes | str, label: str) -> Any:
    try:
        text = data.decode("utf-8") if isinstance(data, bytes) else data
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
        _reject_nonfinite_numbers(value)
        return value
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise DerivationError(f"{label} must be strict UTF-8 JSON") from exc


def _validate_json_document_bytes(data: bytes, relative: str) -> None:
    suffix = PurePosixPath(relative).suffix.casefold()
    if suffix == ".json":
        _strict_json_loads(data, relative)
    elif suffix == ".jsonl":
        lines = data.splitlines()
        if not lines:
            raise DerivationError(f"JSONL document is empty: {relative}")
        for line_number, raw_line in enumerate(lines, start=1):
            if not raw_line:
                raise DerivationError(
                    f"JSONL document contains a blank row: {relative}:{line_number}"
                )
            _strict_json_loads(raw_line, f"{relative}:{line_number}")


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], label: str
) -> None:
    observed = set(value)
    if observed != expected:
        raise DerivationError(
            f"{label} keys do not match schema "
            f"(missing={sorted(expected - observed)}, "
            f"unknown={sorted(observed - expected)})"
        )


def _validate_transform_contract(entry: ProfileEntry) -> None:
    if entry.mode == "copy":
        if entry.inputs != ((entry.source, "0" * 64),):
            raise DerivationError(
                "copy entries must carry their source path with a zero bootstrap hash"
            )
        return
    expected = TRANSFORM_CONTRACTS.get(entry.mode)
    if expected is None:
        raise DerivationError(f"transform contract is missing: {entry.mode}")
    observed = TransformContract(
        source=entry.source,
        destination=entry.destination,
        category=entry.category,
        input_paths=tuple(path for path, _expected_sha256 in entry.inputs),
    )
    for field in ("source", "destination", "category", "input_paths"):
        if getattr(observed, field) != getattr(expected, field):
            raise DerivationError(f"{entry.mode} transform contract {field} drifted")


def _validate_exact_transform_contracts(entries: Sequence[ProfileEntry]) -> None:
    for entry in entries:
        _validate_transform_contract(entry)

    seen_inputs: dict[str, tuple[str, str]] = {}
    for entry in entries:
        for path, _expected_sha256 in entry.inputs:
            key = path.casefold()
            previous = seen_inputs.get(key)
            if previous is not None:
                previous_mode, previous_path = previous
                raise DerivationError(
                    "profile input paths contain a duplicate or casefold collision "
                    f"({previous_mode}:{previous_path}, {entry.mode}:{path})"
                )
            seen_inputs[key] = (entry.mode, path)


def _load_profile(path: Path) -> ClaimCompleteProfile:
    data = builder._require_plain_file(path, "claim-complete profile", 1024 * 1024)
    raw = _strict_json_loads(data, "claim-complete profile")
    if not isinstance(raw, dict):
        raise DerivationError("claim-complete profile root must be an object")
    _require_exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "approval",
            "claim_ids",
            "descriptive_only_destinations",
            "files",
        },
        "claim-complete profile",
    )
    if raw["schema_version"] != SCHEMA_VERSION:
        raise DerivationError("unsupported claim-complete profile schema_version")
    if raw["status"] != STATUS or raw["approval"] != APPROVAL:
        raise DerivationError(
            "profile must remain candidate-only with author approval required"
        )
    if raw["claim_ids"] != list(CLAIM_IDS):
        raise DerivationError(
            "profile must cover admitted claims C1 through C10 exactly"
        )
    descriptive = raw["descriptive_only_destinations"]
    if not isinstance(descriptive, list) or not descriptive:
        raise DerivationError("descriptive_only_destinations must be a non-empty list")
    descriptive_destinations = tuple(
        builder._safe_relative_path(value, "descriptive_only_destination")
        for value in descriptive
    )
    if len({path.casefold() for path in descriptive_destinations}) != len(
        descriptive_destinations
    ):
        raise DerivationError("descriptive-only destinations contain duplicates")

    rows = raw["files"]
    if not isinstance(rows, list) or not rows:
        raise DerivationError("profile files must be a non-empty list")
    entries: list[ProfileEntry] = []
    seen_sources: set[str] = set()
    seen_destinations: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise DerivationError(f"files[{index}] must be an object")
        _require_exact_keys(
            row,
            {"source", "destination", "category", "mode", "inputs"},
            f"files[{index}]",
        )
        source = builder._safe_relative_path(row["source"], f"files[{index}].source")
        destination = builder._safe_relative_path(
            row["destination"], f"files[{index}].destination"
        )
        category = row["category"]
        if not isinstance(category, str) or not builder.SAFE_SLUG_RE.fullmatch(
            category
        ):
            raise DerivationError(f"files[{index}].category is invalid")
        mode = row["mode"]
        if not isinstance(mode, str) or mode not in {"copy", *REQUIRED_DERIVED_MODES}:
            raise DerivationError(f"files[{index}].mode is unsupported")
        inputs_raw = row["inputs"]
        if not isinstance(inputs_raw, list):
            raise DerivationError(f"files[{index}].inputs must be a list")
        inputs: list[tuple[str, str]] = []
        for input_index, item in enumerate(inputs_raw):
            if not isinstance(item, dict):
                raise DerivationError(
                    f"files[{index}].inputs[{input_index}] must be an object"
                )
            _require_exact_keys(
                item,
                {"path", "expected_sha256"},
                f"files[{index}].inputs[{input_index}]",
            )
            input_path = _safe_repo_relative_path(
                item["path"], f"files[{index}].inputs[{input_index}].path"
            )
            expected = item["expected_sha256"]
            if not isinstance(expected, str) or not HEX64_RE.fullmatch(expected):
                raise DerivationError(
                    f"files[{index}].inputs[{input_index}].expected_sha256 is invalid"
                )
            inputs.append((input_path, expected))
        if mode == "copy" and tuple(inputs) != ((source, "0" * 64),):
            raise DerivationError(
                "copy entries must carry their source path with a zero bootstrap hash"
            )
        if mode != "copy" and any(expected == "0" * 64 for _, expected in inputs):
            raise DerivationError(
                "derived inputs must carry nonzero pinned source hashes"
            )
        if mode != "copy" and mode != "derivation_receipt" and not inputs:
            raise DerivationError(
                f"files[{index}] transform must bind at least one input"
            )
        if mode == "derivation_receipt" and inputs:
            raise DerivationError(
                "derivation_receipt must not declare recursive inputs"
            )
        if mode != "copy" and not source.startswith(DERIVED_PREFIX):
            raise DerivationError(
                "derived staging sources must use the reserved prefix"
            )
        source_key = source.casefold()
        destination_key = destination.casefold()
        if source_key in seen_sources or destination_key in seen_destinations:
            raise DerivationError("profile sources and destinations must be unique")
        seen_sources.add(source_key)
        seen_destinations.add(destination_key)
        entries.append(ProfileEntry(source, destination, category, mode, tuple(inputs)))

    mode_counts = Counter(entry.mode for entry in entries if entry.mode != "copy")
    if mode_counts != Counter({mode: 1 for mode in REQUIRED_DERIVED_MODES}):
        raise DerivationError(
            "profile must declare every required derived mode exactly once"
        )
    _validate_exact_special_inputs(entries)
    _validate_exact_transform_contracts(entries)
    missing_descriptive = sorted(
        path
        for path in descriptive_destinations
        if path.casefold() not in seen_destinations
    )
    if missing_descriptive:
        raise DerivationError(
            f"descriptive-only destinations are not payload entries: {missing_descriptive}"
        )
    return ClaimCompleteProfile(
        entries=tuple(entries),
        descriptive_only_destinations=descriptive_destinations,
        raw_sha256=_sha256(data),
    )


def _safe_repo_relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise DerivationError(f"{label} must be a non-empty POSIX relative path")
    if ":" in value:
        raise DerivationError(
            f"{label} cannot contain a Windows drive or alternate-data-stream separator"
        )
    if any(unicodedata.category(char) in {"Cc", "Cf"} for char in value):
        raise DerivationError(f"{label} contains a Unicode control character")
    pure = PurePosixPath(value)
    if pure.is_absolute() or pure.as_posix() != value:
        raise DerivationError(f"{label} must be a normalized relative path")
    if any(part in {"", ".", ".."} for part in pure.parts):
        raise DerivationError(f"{label} cannot contain dot or parent segments")
    for part in pure.parts:
        if part.endswith((".", " ")):
            raise DerivationError(f"{label} cannot contain a trailing dot or space")
        device_stem = part.split(".", 1)[0].casefold()
        if device_stem in builder.WINDOWS_RESERVED_DEVICE_NAMES:
            raise DerivationError(f"{label} contains a Windows reserved device name")
    return value


def _special_input_paths(
    entries: Sequence[ProfileEntry],
) -> tuple[set[str], set[str]]:
    input_paths = {
        relative for entry in entries for relative, _expected_sha256 in entry.inputs
    }
    formal_inputs = {
        relative
        for relative in input_paths
        if relative.casefold().startswith(FORMAL_INPUT_PREFIX.casefold())
    }
    checkpoint_inputs = {
        relative
        for relative in input_paths
        if "checkpoint" in PurePosixPath(relative).name.casefold()
    }
    return formal_inputs, checkpoint_inputs


def _validate_exact_special_inputs(entries: Sequence[ProfileEntry]) -> None:
    formal_inputs, checkpoint_inputs = _special_input_paths(entries)
    if formal_inputs != set(CLAIM_COMPLETE_FORMAL_INPUT_EXCEPTIONS):
        raise DerivationError(
            "formal transform-input exceptions differ from the exact ten files"
        )
    if checkpoint_inputs != set(CLAIM_COMPLETE_CHECKPOINT_INPUT_EXCEPTIONS):
        raise DerivationError(
            "checkpoint transform-input exceptions differ from the exact two files"
        )


def _read_repo_file(root: Path, relative: str) -> bytes:
    safe_relative = _safe_repo_relative_path(relative, "claim-complete source path")
    root_absolute = root.absolute()
    lexical_path = root_absolute.joinpath(
        *PurePosixPath(safe_relative).parts
    ).absolute()
    try:
        lexical_path.relative_to(root_absolute)
    except ValueError as exc:
        raise DerivationError(
            "claim-complete source path escapes the repository root"
        ) from exc
    try:
        resolved_root = root_absolute.resolve(strict=True)
        resolved_path = lexical_path.resolve(strict=True)
        resolved_path.relative_to(resolved_root)
    except (OSError, ValueError) as exc:
        raise DerivationError(
            "claim-complete source path does not resolve inside the repository root"
        ) from exc
    path = builder._assert_no_reparse_chain(root_absolute, safe_relative)
    if path.absolute() != lexical_path:
        raise DerivationError("claim-complete source lexical join drifted")
    return builder._require_plain_file(
        path, f"claim-complete source {safe_relative}", builder.HARD_MAX_FILE_BYTES
    )


HASH_BINDING_PATH_PREFIX = "hashpath-v1:"
HashPathComponent = str | int


def _is_hash_binding_key(key: str) -> bool:
    lowered = key.lower()
    return "sha256" in lowered or lowered.endswith("_hash")


def _encode_hash_binding_path(components: Sequence[HashPathComponent]) -> str:
    if not components:
        raise DerivationError("hash-binding path must contain at least one component")
    for component in components:
        if not isinstance(component, str) and not (
            type(component) is int and component >= 0
        ):
            raise DerivationError("hash-binding path component is invalid")
    try:
        payload = json.dumps(
            list(components),
            ensure_ascii=False,
            sort_keys=False,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise DerivationError("hash-binding path cannot be encoded") from exc
    return HASH_BINDING_PATH_PREFIX + payload


def _decode_hash_binding_path(value: Any) -> tuple[HashPathComponent, ...]:
    if not isinstance(value, str) or not value.startswith(HASH_BINDING_PATH_PREFIX):
        raise DerivationError("hash-binding path encoding prefix is invalid")
    payload = value[len(HASH_BINDING_PATH_PREFIX) :]
    components = _strict_json_loads(payload, "hash-binding path encoding")
    if not isinstance(components, list) or not components:
        raise DerivationError("hash-binding path encoding must be a non-empty array")
    for component in components:
        if not isinstance(component, str) and not (
            type(component) is int and component >= 0
        ):
            raise DerivationError("hash-binding path component is invalid")
    if not isinstance(components[-1], str) or not _is_hash_binding_key(components[-1]):
        raise DerivationError("hash-binding path does not end at a hash field")
    decoded = tuple(components)
    if _encode_hash_binding_path(decoded) != value:
        raise DerivationError("hash-binding path encoding is not canonical")
    return decoded


def _legacy_hash_binding_path(components: Sequence[HashPathComponent]) -> str:
    path = "$"
    for component in components:
        if isinstance(component, str):
            path += f".{component}"
        else:
            path += f"[{component}]"
    return path


def _validate_hash_bindings(value: Any, label: str) -> int:
    if not isinstance(value, dict):
        raise DerivationError(f"{label} must be an object")
    encoded_paths: set[str] = set()
    legacy_origins: dict[str, str] = {}
    for encoded_path, digest in value.items():
        components = _decode_hash_binding_path(encoded_path)
        if encoded_path in encoded_paths:
            raise DerivationError(f"{label} contains a duplicate encoded path")
        encoded_paths.add(encoded_path)
        legacy_path = _legacy_hash_binding_path(components)
        previous = legacy_origins.get(legacy_path)
        if previous is not None and previous != encoded_path:
            raise DerivationError(
                f"{label} contains a lossy flattened-path collision: {legacy_path}"
            )
        legacy_origins[legacy_path] = encoded_path
        if not isinstance(digest, str) or not HEX64_RE.fullmatch(digest):
            raise DerivationError(f"{label} contains an invalid SHA-256 binding")
    return len(encoded_paths)


def _flatten_hashes(value: Any, prefix: str = "$") -> dict[str, str]:
    if prefix != "$":
        raise DerivationError("custom hash-flatten prefixes are unsupported")
    found: dict[str, str] = {}
    legacy_origins: dict[str, str] = {}

    def visit(child: Any, components: tuple[HashPathComponent, ...]) -> None:
        if isinstance(child, dict):
            for key, nested in child.items():
                if not isinstance(key, str):
                    raise DerivationError("hash-binding object key must be a string")
                nested_components = (*components, key)
                if (
                    isinstance(nested, str)
                    and HEX64_RE.fullmatch(nested)
                    and _is_hash_binding_key(key)
                ):
                    encoded_path = _encode_hash_binding_path(nested_components)
                    legacy_path = _legacy_hash_binding_path(nested_components)
                    previous = legacy_origins.get(legacy_path)
                    if previous is not None and previous != encoded_path:
                        raise DerivationError(
                            "hash-binding paths collide under the legacy flattened "
                            f"encoding: {legacy_path}"
                        )
                    if encoded_path in found:
                        raise DerivationError(
                            f"duplicate hash-binding path is forbidden: {encoded_path}"
                        )
                    legacy_origins[legacy_path] = encoded_path
                    found[encoded_path] = nested.lower()
                else:
                    visit(nested, nested_components)
        elif isinstance(child, list):
            for index, nested in enumerate(child):
                visit(nested, (*components, index))

    visit(value, ())
    _validate_hash_bindings(found, "flattened hash bindings")
    return found


def _claim_ledger_transformations() -> dict[str, Any]:
    return {
        "claim_rewrites": [
            {
                "claim_id": claim_id,
                "source_text": source_text,
                "candidate_text": candidate_text,
                "replacement_count": 1,
            }
            for claim_id, (source_text, candidate_text) in sorted(
                CLAIM_LEDGER_CLAIM_REWRITES.items()
            )
        ],
        "limitation_rewrites": [
            {
                "claim_id": claim_id,
                "source_text": source_text,
                "candidate_text": candidate_text,
                "replacement_count": 1,
            }
            for claim_id, (source_text, candidate_text) in sorted(
                CLAIM_LEDGER_LIMITATION_REWRITES.items()
            )
        ],
        "authoritative_evidence_path_rewrites": [
            {
                "source_path": source_path,
                "candidate_path": candidate_path,
                "replacement_count": 1,
            }
            for source_path, candidate_path in CLAIM_LEDGER_EVIDENCE_PATH_REWRITES
        ],
        "authoritative_evidence_additions": [
            {
                "claim_id": claim_id,
                "candidate_path": candidate_path,
                "addition_count": 1,
            }
            for claim_id, candidate_path in sorted(
                CLAIM_LEDGER_EVIDENCE_ADDITIONS.items()
            )
        ],
    }


def _claim_ledger(source_path: str, source: bytes) -> tuple[bytes, dict[str, Any]]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DerivationError("claim ledger source is not UTF-8") from exc
    claims = []
    claim_rewrites: set[str] = set()
    limitation_rewrites: set[str] = set()
    path_rewrite_counts: Counter[str] = Counter()
    evidence_additions: set[str] = set()
    observed_non_path_evidence: set[str] = set()
    path_rewrite_map = dict(CLAIM_LEDGER_EVIDENCE_PATH_REWRITES)
    for line in text.splitlines():
        if not re.match(r"^\| C\d+ \|", line):
            continue
        cells = [cell.strip() for cell in line.split("|")[1:-1]]
        if len(cells) != 5:
            raise DerivationError("claim ledger table shape drifted")
        claim_id, claim, evidence, limitation, locations = cells
        claim_rewrite = CLAIM_LEDGER_CLAIM_REWRITES.get(claim_id)
        if claim_rewrite is not None:
            source_claim, candidate_claim = claim_rewrite
            if claim != source_claim:
                raise DerivationError(f"{claim_id} source claim text drifted")
            claim = candidate_claim
            claim_rewrites.add(claim_id)

        limitation_rewrite = CLAIM_LEDGER_LIMITATION_REWRITES.get(claim_id)
        if limitation_rewrite is not None:
            source_limitation, candidate_limitation = limitation_rewrite
            if limitation != source_limitation:
                raise DerivationError(f"{claim_id} source limitation text drifted")
            limitation = candidate_limitation
            limitation_rewrites.add(claim_id)

        evidence_clauses: list[str] = []
        evidence_paths: set[str] = set()
        for clause in (item.strip() for item in evidence.split(";")):
            match = CLAIM_LEDGER_PATH_CLAUSE_RE.fullmatch(clause)
            if match is None:
                if clause not in CLAIM_LEDGER_NON_PATH_EVIDENCE:
                    raise DerivationError(
                        f"{claim_id} authoritative evidence clause is not classified"
                    )
                observed_non_path_evidence.add(clause)
                evidence_clauses.append(clause)
                continue
            source_evidence_path = _safe_repo_relative_path(
                match.group(1), f"{claim_id} authoritative evidence path"
            )
            candidate_evidence_path = path_rewrite_map.get(
                source_evidence_path, source_evidence_path
            )
            candidate_evidence_path = _safe_repo_relative_path(
                candidate_evidence_path,
                f"{claim_id} candidate authoritative evidence path",
            )
            evidence_key = candidate_evidence_path.casefold()
            if evidence_key in evidence_paths:
                raise DerivationError(
                    f"{claim_id} authoritative evidence paths collide"
                )
            evidence_paths.add(evidence_key)
            evidence_clauses.append(f"`{candidate_evidence_path}`")
            if candidate_evidence_path != source_evidence_path:
                path_rewrite_counts[source_evidence_path] += 1

        added_evidence_path = CLAIM_LEDGER_EVIDENCE_ADDITIONS.get(claim_id)
        if added_evidence_path is not None:
            added_evidence_path = _safe_repo_relative_path(
                added_evidence_path,
                f"{claim_id} added authoritative evidence path",
            )
            if added_evidence_path.casefold() in evidence_paths:
                raise DerivationError(
                    f"{claim_id} added authoritative evidence path is duplicated"
                )
            evidence_clauses.append(f"`{added_evidence_path}`")
            evidence_additions.add(claim_id)
        evidence = "; ".join(evidence_clauses)
        claims.append(
            {
                "id": claim_id,
                "claim": claim,
                "authoritative_evidence": evidence,
                "required_limitation": limitation,
                "paper_locations": locations,
            }
        )
    if [item["id"] for item in claims] != list(CLAIM_IDS):
        raise DerivationError("claim ledger no longer contains admitted C1-C10 exactly")
    if claim_rewrites != set(CLAIM_LEDGER_CLAIM_REWRITES):
        raise DerivationError("claim ledger C4-C7 claim rewrite coverage drifted")
    if limitation_rewrites != set(CLAIM_LEDGER_LIMITATION_REWRITES):
        raise DerivationError("claim ledger C5-C7 limitation rewrite coverage drifted")
    if evidence_additions != set(CLAIM_LEDGER_EVIDENCE_ADDITIONS):
        raise DerivationError("claim ledger seed-audit evidence additions drifted")
    expected_path_rewrites = Counter(
        {
            source_path: 1
            for source_path, _candidate_path in CLAIM_LEDGER_EVIDENCE_PATH_REWRITES
        }
    )
    if path_rewrite_counts != expected_path_rewrites:
        raise DerivationError(
            "claim ledger authoritative-evidence path rewrite coverage drifted"
        )
    if observed_non_path_evidence != set(CLAIM_LEDGER_NON_PATH_EVIDENCE):
        raise DerivationError(
            "claim ledger non-path authoritative-evidence clauses drifted"
        )
    value = {
        "schema_name": "lifeline-admitted-claim-evidence-limitation-ledger",
        "schema_version": 1,
        "candidate_status": STATUS,
        "approval": APPROVAL,
        "scope": "admitted_only",
        "claim_count": len(claims),
        "claim_ids": list(CLAIM_IDS),
        "claims": claims,
        "source_binding": {
            "path": source_path,
            "sha256": _sha256(source),
            "size_bytes": len(source),
        },
        "interpretation_boundary": (
            "Each claim is admitted only together with its required limitation; "
            "no stronger inference is admitted by this candidate."
        ),
    }
    data = _canonical_json_bytes(value)
    return data, {
        "transformation": (
            "selected admitted C1-C10 table rows into canonical JSON and applied "
            "the exact candidate claim, limitation, and evidence-routing rewrites"
        ),
        "transformations": _claim_ledger_transformations(),
        "claim_ids": list(CLAIM_IDS),
        "claim_count": len(claims),
    }


def _d14_protocol(source: bytes) -> tuple[bytes, dict[str, Any]]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DerivationError("D14-D16 protocol source is not UTF-8") from exc
    python_prefix = re.compile(
        r"& '[A-Za-z]:\\Users\\[^\\']+\\anaconda3\\envs\\[^\\']+\\python\.exe'"
    )
    text, python_replacements = python_prefix.subn("python", text)
    root_literal = re.compile(r"(?i)[A-Z]:\\coding\\py\\line game")
    text, root_replacements = root_literal.subn("<REPOSITORY_ROOT>", text)
    if python_replacements != 10 or root_replacements != 1:
        raise DerivationError(
            "D14-D16 protocol anonymization count drifted "
            f"(python={python_replacements}, root={root_replacements})"
        )
    header = (
        "<!-- Anonymous candidate derivative. Scientific protocol content and budgets are "
        "unchanged; only host-specific command prefixes were made portable. Historical "
        "run-status statements describe the frozen pre-execution snapshot; current evidence "
        "status is carried by the receipt ledger and verifier outputs. The referenced "
        "configs/d14_d16_formal_manifest.json is packaged here as "
        "configs/d14_d16_formal_manifest.frozen_preexecution.json. -->\n\n"
    )
    return (header + text).encode("utf-8"), {
        "transformations": {
            "python_executable_prefixes_replaced": python_replacements,
            "repository_roots_replaced": root_replacements,
            "historical_status_context_added": True,
            "scientific_values_changed": False,
        }
    }


def _compact_receipt(
    raw: dict[str, Any], line_number: int, raw_line: bytes
) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "source_receipt_line": line_number,
        "source_receipt_sha256": _sha256(raw_line),
    }
    for field in RECEIPT_FIELDS:
        if field in raw:
            compact[field] = raw[field]
    matchup: dict[str, Any] = {}
    for field in ("agent_a", "agent_b"):
        agent = raw.get(field)
        if isinstance(agent, dict):
            matchup[field] = {
                key: agent[key]
                for key in ("name", "class")
                if key in agent and isinstance(agent[key], str)
            }
    if matchup:
        compact["matchup"] = matchup
    compact["hash_bindings"] = _flatten_hashes(raw)
    return compact


def _compact_ledger(source: bytes) -> tuple[bytes, dict[str, Any]]:
    raw_lines = source.splitlines()
    kind_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    rendered: list[str] = []
    hash_binding_count = 0
    for line_number, raw_line in enumerate(raw_lines, start=1):
        receipt = _strict_json_loads(raw_line, f"receipt ledger line {line_number}")
        if not isinstance(receipt, dict):
            raise DerivationError(f"receipt ledger line {line_number} is not an object")
        kind_counts[str(receipt.get("result_kind"))] += 1
        status_counts[str(receipt.get("status"))] += 1
        compact = _compact_receipt(receipt, line_number, raw_line)
        hash_binding_count += len(compact["hash_bindings"])
        try:
            rendered.append(
                json.dumps(
                    compact,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
            )
        except (TypeError, ValueError) as exc:
            raise DerivationError(
                f"compact receipt line {line_number} is not JSON serializable"
            ) from exc
    if len(raw_lines) != 330 or kind_counts != {"training": 15, "evaluation": 315}:
        raise DerivationError(
            f"formal ledger count drifted (rows={len(raw_lines)}, kinds={dict(kind_counts)})"
        )
    if status_counts != {"complete": 330}:
        raise DerivationError(f"formal ledger status drifted: {dict(status_counts)}")
    if hash_binding_count != 4695:
        raise DerivationError(
            f"formal ledger retained hash-binding count drifted: {hash_binding_count}"
        )
    data = ("\n".join(rendered) + "\n").encode("utf-8")
    return data, {
        "transformation": (
            "selected claim-relevant scalar fields, matchup labels, every hash "
            "binding, and a SHA-256 of each exact source line; omitted local paths, "
            "checkpoint bytes, raw trajectories, logs, and task-tree locations"
        ),
        "source_receipts": len(raw_lines),
        "source_result_kind_counts": dict(sorted(kind_counts.items())),
        "source_status_counts": dict(sorted(status_counts.items())),
        "retained_hash_bindings": hash_binding_count,
    }


def _ledger_status(
    source: bytes, compact_ledger: bytes
) -> tuple[bytes, dict[str, Any]]:
    raw = _strict_json_loads(source, "ledger status source")
    if not isinstance(raw, dict) or "ledger_path" not in raw:
        raise DerivationError("ledger status absolute-path field is missing")
    removed = raw.pop("ledger_path")
    if not isinstance(removed, str) or not re.match(r"(?i)^[a-z]:[\\/]", removed):
        raise DerivationError(
            "ledger status path no longer has the expected absolute shape"
        )
    raw.update(
        {
            "candidate_status": STATUS,
            "approval": APPROVAL,
            "candidate_derivation": {
                "source_status_sha256": _sha256(source),
                "absolute_ledger_path_removed": True,
            },
            "candidate_ledger": {
                "path": "receipts/d14_d16_compact_receipts.jsonl",
                "sha256": _sha256(compact_ledger),
                "size_bytes": len(compact_ledger),
                "receipt_count": 330,
            },
        }
    )
    return _canonical_json_bytes(raw), {
        "transformation": "removed absolute ledger_path and bound the compact ledger",
        "absolute_ledger_path_removed": True,
    }


def _superko_config(source: bytes) -> tuple[bytes, dict[str, Any]]:
    raw = _strict_json_loads(source, "Superko configuration source")
    if not isinstance(raw, dict):
        raise DerivationError(
            "Superko configuration source has an invalid object shape"
        )
    _require_exact_keys(
        raw, set(SUPERKO_CONFIG_SOURCE_KEYS), "Superko configuration source"
    )
    if not isinstance(raw.get("checkpoint"), dict) or not isinstance(
        raw.get("source_sha256"), dict
    ):
        raise DerivationError(
            "Superko configuration source has an invalid object shape"
        )
    _require_exact_keys(
        raw["checkpoint"],
        set(SUPERKO_CHECKPOINT_SOURCE_KEYS),
        "Superko checkpoint source",
    )
    if not isinstance(raw["checkpoint"]["path"], str) or not raw["checkpoint"]["path"]:
        raise DerivationError("Superko checkpoint source path is invalid")
    checkpoint = dict(raw["checkpoint"])
    checkpoint.pop("path", None)
    checkpoint["bytes_included"] = False
    checkpoint["omission_reason"] = (
        "Local engineering-smoke checkpoint bytes are excluded."
    )
    normalized_sources: dict[str, Any] = {}
    normalized_keys: dict[str, str] = {}
    normalized_count = 0
    for key, value in raw["source_sha256"].items():
        normalized_key = key.replace("\\", "/")
        normalized_key = _safe_repo_relative_path(
            normalized_key, "Superko source_sha256 normalized path key"
        )
        collision_key = normalized_key.casefold()
        if collision_key in normalized_keys:
            raise DerivationError(
                "Superko source_sha256 path keys collide after POSIX/casefold "
                "normalization"
            )
        normalized_keys[collision_key] = normalized_key
        normalized_sources[normalized_key] = value
        normalized_count += key != normalized_key
    omitted = {
        "attempt2_preflight": "Smoke/preflight details are excluded from the candidate.",
        "retry_lineage": "Attempt-local retry detail is represented by a reviewed receipt.",
    }
    transformations = {
        "checkpoint_path_removed": True,
        "checkpoint_bytes_included": False,
        "checkpoint_hash_values_retained_under": "checkpoint_identity",
        "omitted_top_level_fields": omitted,
        "source_sha256_path_keys_normalized_to_posix": normalized_count,
        "scientific_config_or_hash_values_changed": False,
    }
    derived = {
        "schema_version": raw["schema_version"],
        "experiment": raw["experiment"],
        "candidate_status": STATUS,
        "approval": APPROVAL,
        "candidate_derivation": {
            "source_sha256": _sha256(source),
            "transformations": transformations,
        },
        "formal_config": raw["formal_config"],
        "source_sha256": normalized_sources,
        "checkpoint_identity": checkpoint,
        "checkpoint_provenance": raw["checkpoint_provenance"],
        "expected_receipt": raw["expected_receipt"],
        "verification": raw["verification"],
    }
    return _canonical_json_bytes(derived), {"transformations": transformations}


def _superko_verification(source: bytes) -> tuple[bytes, dict[str, Any]]:
    raw = _strict_json_loads(source, "Superko verification source")
    if not isinstance(raw, dict):
        raise DerivationError("Superko verification source must be an object")
    _require_exact_keys(
        raw,
        set(SUPERKO_VERIFICATION_SOURCE_KEYS),
        "Superko verification source",
    )
    raw["verifier_command"] = (
        "python -B scripts/verify_superko_policy_matrix.py "
        "results/validation/superko_policy_matrix_five_seed_v1_attempt2.json"
    )
    raw["candidate_status"] = STATUS
    raw["approval"] = APPROVAL
    raw["candidate_derivation"] = {
        "source_sha256": _sha256(source),
        "host_specific_python_path_removed": True,
    }
    return _canonical_json_bytes(raw), {
        "transformation": "replaced the host-specific Python executable in verifier_command"
    }


def _environment_receipt(
    source: bytes, generated: Mapping[str, bytes] | None = None
) -> tuple[bytes, dict[str, Any]]:
    raw = _strict_json_loads(source, "environment verification source")
    if not isinstance(raw, dict):
        raise DerivationError("environment verification source must be an object")
    _require_exact_keys(
        raw,
        set(ENVIRONMENT_RECEIPT_SOURCE_KEYS),
        "environment verification source",
    )
    formal_metadata = raw.get("formal_execution_metadata")
    lock = raw.get("lock")
    verifier = raw.get("verifier")
    expected_command = [
        "python",
        "-B",
        ENVIRONMENT_VERIFIER_PATH,
        "--lock",
        ENVIRONMENT_LOCK_PATH,
        "--metadata",
        ENVIRONMENT_METADATA_PATH,
        "--output",
        ENVIRONMENT_RECEIPT_PATH,
    ]
    if (
        raw.get("schema_name") != "lifeline-d14-d16-environment-verification"
        or type(raw.get("schema_version")) is not int
        or raw.get("schema_version") != 1
        or raw.get("ok") is not True
        or raw.get("errors") != []
        or not isinstance(formal_metadata, dict)
        or formal_metadata.get("path") != ENVIRONMENT_METADATA_PATH
        or not isinstance(formal_metadata.get("sha256"), str)
        or not builder.SHA256_RE.fullmatch(formal_metadata["sha256"])
        or not isinstance(formal_metadata.get("source_execution_metadata_sha256"), str)
        or not builder.SHA256_RE.fullmatch(
            formal_metadata["source_execution_metadata_sha256"]
        )
        or not isinstance(lock, dict)
        or lock.get("path") != ENVIRONMENT_LOCK_PATH
        or not isinstance(lock.get("sha256"), str)
        or not builder.SHA256_RE.fullmatch(lock["sha256"])
        or not isinstance(verifier, dict)
        or verifier.get("path") != ENVIRONMENT_VERIFIER_PATH
        or not isinstance(verifier.get("sha256"), str)
        or not builder.SHA256_RE.fullmatch(verifier["sha256"])
        or verifier.get("semantic_command") != expected_command
    ):
        raise DerivationError(
            "environment receipt is not the frozen path-safe v2 verifier output"
        )

    available = generated if generated is not None else {}
    generated_bindings = {
        path: available.get(path)
        for path in (
            ENVIRONMENT_LOCK_PATH,
            ENVIRONMENT_METADATA_PATH,
            ENVIRONMENT_VERIFIER_PATH,
        )
    }
    if any(data is None for data in generated_bindings.values()):
        raise DerivationError(
            "environment lock, metadata, and verifier copies must precede the receipt"
        )
    metadata_copy = _strict_json_loads(
        generated_bindings[ENVIRONMENT_METADATA_PATH],
        "portable execution metadata copy",
    )
    if (
        not isinstance(metadata_copy, dict)
        or metadata_copy.get("source_execution_metadata_sha256")
        != formal_metadata["source_execution_metadata_sha256"]
        or formal_metadata["sha256"]
        != _sha256(generated_bindings[ENVIRONMENT_METADATA_PATH])
        or lock["sha256"] != _sha256(generated_bindings[ENVIRONMENT_LOCK_PATH])
        or verifier["sha256"] != _sha256(generated_bindings[ENVIRONMENT_VERIFIER_PATH])
    ):
        raise DerivationError(
            "environment receipt hashes do not bind the generated candidate copies"
        )

    raw["candidate_status"] = STATUS
    raw["approval"] = APPROVAL
    raw["acquisition_boundary"] = (
        "hash-bound environment receipt and lock only; no clean-install execution is claimed"
    )
    raw["candidate_derivation"] = {
        "source_sha256": _sha256(source),
        "source_paths_already_repository_relative": True,
        "repository_absolute_paths_replaced": 0,
        "repository_relative_bindings_verified": 3,
        "candidate_copy_hash_bindings_verified": 3,
    }
    return _canonical_json_bytes(raw), {
        "transformation": (
            "preserved the path-safe v2 receipt and added candidate-only boundaries"
        ),
        "repository_paths_replaced": 0,
        "repository_relative_bindings_verified": 3,
        "candidate_copy_hash_bindings_verified": 3,
        "clean_install_execution_claimed": False,
    }


def _terminology_erratum(source: bytes) -> tuple[bytes, dict[str, Any]]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DerivationError("terminology erratum source is not UTF-8") from exc
    later_result_sentence = "- 本勘误不接纳 D17、D18、D19 或任何未通过 gate 的结果。"
    ledger_reference = "`paper/CLAIM_EVIDENCE_LIMITATION_V3.md`"
    if text.count(later_result_sentence) != 1 or text.count(ledger_reference) != 1:
        raise DerivationError("terminology erratum anonymization anchors drifted")
    text = text.replace(
        later_result_sentence,
        "- 本勘误不接纳任何后续或未通过 gate 的结果。",
    ).replace(
        ledger_reference,
        "`evidence/claims/CLAIM_EVIDENCE_LIMITATION.admitted.json`",
    )
    header = (
        "<!-- Anonymous candidate derivative. One prohibited later-result label was "
        "generalized and the paper-tree ledger reference was redirected to the admitted "
        "candidate ledger; numerical and scientific clarifications are unchanged. -->\n\n"
    )
    return (header + text).encode("utf-8"), {
        "transformation": (
            "generalized one later-result exclusion sentence and redirected one "
            "paper-tree ledger reference"
        ),
        "scientific_values_changed": False,
    }


def _reference_trace(source: bytes) -> tuple[bytes, dict[str, Any]]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DerivationError("reference trace source is not UTF-8") from exc
    original = "../../../web/web前端/GameEngine.js"
    portable = "../../../web/GameEngine.js"
    if text.count(original) != 1:
        raise DerivationError("reference trace GameEngine path anchor drifted")
    derived = text.replace(original, portable).encode("utf-8")
    return derived, {
        "transformation": "redirected one relative GameEngine import to the ASCII candidate path",
        "import_path_replacements": 1,
    }


def _entry_input_bytes(
    entry: ProfileEntry,
    subject_files: Mapping[str, subject_binding.SubjectFileSnapshot],
) -> tuple[list[bytes], list[dict[str, Any]]]:
    values: list[bytes] = []
    receipts: list[dict[str, Any]] = []
    for relative, expected_sha256 in entry.inputs:
        snapshot = subject_files.get(relative)
        if snapshot is None:
            raise DerivationError(f"transform input is not Git-tracked: {relative}")
        data = snapshot.data
        observed = snapshot.sha256
        if expected_sha256 != "0" * 64 and observed != expected_sha256:
            raise DerivationError(f"transform source hash drifted: {relative}")
        values.append(data)
        receipts.append(
            {
                "path": relative,
                "sha256": observed,
                "size_bytes": len(data),
            }
        )
    return values, receipts


def _derive_entry(
    entry: ProfileEntry,
    subject_files: Mapping[str, subject_binding.SubjectFileSnapshot],
    generated: Mapping[str, bytes],
) -> tuple[bytes, dict[str, Any]]:
    _validate_transform_contract(entry)
    inputs, input_receipts = _entry_input_bytes(entry, subject_files)
    if entry.mode == "copy":
        (copy_source,) = inputs
        data = copy_source
        details: dict[str, Any] = {"transformation": "byte_identical_copy"}
    elif entry.mode == "claim_ledger":
        (ledger_source,) = inputs
        data, details = _claim_ledger(entry.inputs[0][0], ledger_source)
    elif entry.mode == "d14_protocol":
        (protocol_source,) = inputs
        data, details = _d14_protocol(protocol_source)
    elif entry.mode == "compact_ledger":
        (receipt_source,) = inputs
        data, details = _compact_ledger(receipt_source)
    elif entry.mode == "ledger_status":
        (status_source,) = inputs
        compact_path = DERIVED_PREFIX + "d14_d16_compact_receipts.jsonl"
        if compact_path not in generated:
            raise DerivationError("compact ledger must be derived before ledger status")
        data, details = _ledger_status(status_source, generated[compact_path])
    elif entry.mode == "superko_config":
        (config_source,) = inputs
        data, details = _superko_config(config_source)
    elif entry.mode == "superko_verification":
        (verification_source,) = inputs
        data, details = _superko_verification(verification_source)
    elif entry.mode == "environment_receipt":
        (environment_source,) = inputs
        data, details = _environment_receipt(environment_source, generated)
    elif entry.mode == "terminology_erratum":
        (erratum_source,) = inputs
        data, details = _terminology_erratum(erratum_source)
    elif entry.mode == "game_engine_copy":
        (engine_source,) = inputs
        data = engine_source
        details = {"transformation": "byte_identical_copy_to_ascii_candidate_path"}
    elif entry.mode == "reference_trace":
        (trace_source,) = inputs
        data, details = _reference_trace(trace_source)
    else:
        raise DerivationError(f"entry mode must be handled later: {entry.mode}")
    return data, {
        "candidate_path": entry.destination,
        "staging_source": entry.source,
        "category": entry.category,
        "mode": entry.mode,
        "inputs": input_receipts,
        "derived_size_bytes": len(data),
        "derived_sha256": _sha256(data),
        **details,
    }


def _load_allowlist_shape(path: Path) -> tuple[builder.AllowlistConfig, bytes]:
    data = builder._require_plain_file(path, "claim-complete allowlist", 1024 * 1024)
    raw = _strict_json_loads(data, "claim-complete allowlist")
    canonical = _canonical_json_bytes(raw)
    if data != canonical:
        raise DerivationError(
            "claim-complete allowlist must be canonical UTF-8 JSON with LF newlines"
        )
    config = builder.load_allowlist(path)
    if config.raw_sha256 != _sha256(data):
        raise DerivationError(
            "claim-complete allowlist changed between canonical check and parsing"
        )
    return config, data


def _profile_rows(profile: ClaimCompleteProfile) -> list[dict[str, str]]:
    return [
        {
            "source": entry.source,
            "destination": entry.destination,
            "category": entry.category,
        }
        for entry in profile.entries
    ]


def _validate_allowlist_shape(
    profile: ClaimCompleteProfile, allowlist: builder.AllowlistConfig
) -> None:
    expected = _profile_rows(profile)
    observed = [
        {
            "source": entry.source,
            "destination": entry.destination,
            "category": entry.category,
        }
        for entry in allowlist.files
    ]
    if observed != expected:
        raise DerivationError(
            "allowlist rows differ from the ordered claim-complete profile"
        )
    if allowlist.require_git_tracked:
        raise DerivationError(
            "staged claim-complete allowlist must set require_git_tracked=false"
        )
    if allowlist.package_name != CLAIM_PACKAGE_NAME:
        raise DerivationError("claim-complete allowlist package_name drifted")
    if allowlist.purpose != CLAIM_PURPOSE:
        raise DerivationError("claim-complete allowlist purpose drifted")
    if (
        allowlist.max_file_bytes != CLAIM_MAX_FILE_BYTES
        or allowlist.max_total_bytes != CLAIM_MAX_TOTAL_BYTES
    ):
        raise DerivationError("claim-complete allowlist limits drifted")


def _bootstrap_allowlist(
    profile: ClaimCompleteProfile, generated: Mapping[str, bytes]
) -> bytes:
    value = {
        "schema_version": 1,
        "status": STATUS,
        "package_name": CLAIM_PACKAGE_NAME,
        "purpose": CLAIM_PURPOSE,
        "require_git_tracked": False,
        "limits": {
            "max_file_bytes": CLAIM_MAX_FILE_BYTES,
            "max_total_bytes": CLAIM_MAX_TOTAL_BYTES,
        },
        "files": [
            {
                "source": entry.source,
                "destination": entry.destination,
                "category": entry.category,
                "expected_sha256": (
                    None
                    if entry.mode == "derivation_receipt"
                    else _sha256(generated[entry.source])
                ),
            }
            for entry in profile.entries
        ],
    }
    return _canonical_json_bytes(value)


def _validate_existing_plain_directory_chain(path: Path, label: str) -> Path:
    absolute = path.absolute()
    chain = [absolute]
    while chain[-1].parent != chain[-1]:
        chain.append(chain[-1].parent)
    for directory in reversed(chain):
        if not directory.exists() and not directory.is_symlink():
            raise DerivationError(f"{label} has a missing ancestor")
        try:
            info = os.lstat(directory)
            is_reparse = builder._is_reparse(directory)
        except OSError as exc:
            raise DerivationError(f"{label} cannot be inspected safely") from exc
        if is_reparse or not stat.S_ISDIR(info.st_mode):
            raise DerivationError(f"{label} must be an existing plain directory")
    return absolute


def _paths_overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def derive_payload(
    source_root: Path,
    profile_path: Path,
    output: Path,
    allowlist_path: Path | None,
    subject_commit: str,
    subject_tree: str,
    bootstrap_allowlist_output: Path | None = None,
) -> dict[str, Any]:
    repo_root = source_root.absolute()
    if not repo_root.is_dir():
        raise DerivationError("source root is not an existing directory")
    profile = _load_profile(profile_path)
    if allowlist_path is None and bootstrap_allowlist_output is None:
        raise DerivationError(
            "bootstrap derivation requires a new --bootstrap-allowlist-output path"
        )
    allowlist: builder.AllowlistConfig | None = None
    allowlist_bytes: bytes | None = None
    if allowlist_path is not None:
        allowlist, allowlist_bytes = _load_allowlist_shape(allowlist_path)
        _validate_allowlist_shape(profile, allowlist)

    try:
        frozen_paths = {
            relative for entry in profile.entries for relative, _digest in entry.inputs
        }
        profile_relative = subject_binding.canonical_repo_relative(
            repo_root, profile_path, "claim-complete profile"
        )
        frozen_paths.add(profile_relative)
        allowlist_relative: str | None = None
        if allowlist_path is not None:
            allowlist_relative = subject_binding.canonical_repo_relative(
                repo_root, allowlist_path, "claim-complete allowlist"
            )
            frozen_paths.add(allowlist_relative)
        subject_snapshot = subject_binding.verify_subject_repository(
            repo_root,
            subject_commit,
            subject_tree,
            frozen_paths=frozen_paths,
            tool_paths=(
                Path(__file__),
                Path(builder.__file__),
                Path(subject_binding.__file__),
            ),
        )
    except subject_binding.SubjectBindingError as exc:
        raise DerivationError(str(exc)) from exc
    subject_files = {item.relative: item for item in subject_snapshot.files}
    profile_snapshot = subject_files.get(profile_relative)
    if profile_snapshot is None or profile_snapshot.sha256 != profile.raw_sha256:
        raise DerivationError(
            "parsed claim-complete profile does not match the subject commit blob"
        )
    if allowlist is not None:
        allowlist_snapshot = subject_files.get(allowlist_relative or "")
        if (
            allowlist_snapshot is None
            or allowlist_snapshot.sha256 != allowlist.raw_sha256
        ):
            raise DerivationError(
                "parsed claim-complete allowlist does not match the subject commit blob"
            )

    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise DerivationError("staging output already exists; overwrite is forbidden")
    _validate_existing_plain_directory_chain(output.parent, "staging output parent")
    if bootstrap_allowlist_output is not None:
        bootstrap_allowlist_output = bootstrap_allowlist_output.absolute()
        if _paths_overlap(output, bootstrap_allowlist_output):
            raise DerivationError(
                "bootstrap allowlist output must not overlap the staging output"
            )
        if (
            bootstrap_allowlist_output.exists()
            or bootstrap_allowlist_output.is_symlink()
        ):
            raise DerivationError("bootstrap allowlist output already exists")
        _validate_existing_plain_directory_chain(
            bootstrap_allowlist_output.parent,
            "bootstrap allowlist output parent",
        )

    generated: dict[str, bytes] = {}
    receipts: list[dict[str, Any]] = []
    created = False
    output.mkdir()
    created = True
    try:
        receipt_entry: ProfileEntry | None = None
        for entry in profile.entries:
            if entry.mode == "derivation_receipt":
                receipt_entry = entry
                continue
            data, receipt = _derive_entry(entry, subject_files, generated)
            generated[entry.source] = data
            receipts.append(receipt)

        if receipt_entry is None:
            raise DerivationError("derivation receipt entry is missing")
        receipt_value = {
            "schema_name": "lifeline-claim-complete-anonymization-derivation",
            "schema_version": 1,
            "candidate_status": STATUS,
            "approval": APPROVAL,
            **subject_snapshot.binding.public_fields(),
            "subject_binding_verified": True,
            "profile_sha256": profile.raw_sha256,
            "claim_ids": list(CLAIM_IDS),
            "descriptive_only_destinations": list(
                profile.descriptive_only_destinations
            ),
            "source_bindings": receipts,
            "receipt_scope": (
                "All payload entries except this non-recursive receipt; the final "
                "candidate manifest records its actual hash and size, while the "
                "claim verifier regenerates and compares its canonical bytes."
            ),
        }
        receipt_data = _canonical_json_bytes(receipt_value)
        generated[receipt_entry.source] = receipt_data
        receipts.append(
            {
                "candidate_path": receipt_entry.destination,
                "staging_source": receipt_entry.source,
                "category": receipt_entry.category,
                "mode": receipt_entry.mode,
                "inputs": [],
                "derived_size_bytes": len(receipt_data),
                "derived_sha256": _sha256(receipt_data),
                "transformation": "non-recursive receipt over all other payload bindings",
            }
        )

        expected_sources = {entry.source for entry in profile.entries}
        if set(generated) != expected_sources:
            raise DerivationError("generated source set differs from the profile")
        if allowlist is not None:
            for entry in allowlist.files:
                observed = _sha256(generated[entry.source])
                if (
                    entry.expected_sha256 is not None
                    and observed != entry.expected_sha256
                ):
                    raise DerivationError(
                        f"derived payload hash drifted: {entry.source}"
                    )

        for entry in profile.entries:
            _validate_json_document_bytes(generated[entry.source], entry.destination)
            text = generated[entry.source].decode("utf-8-sig")
            search_text = entry.source + "\n" + entry.destination + "\n" + text
            if PROHIBITED_EXTENSION_RE.search(search_text):
                raise DerivationError(
                    f"prohibited extension label reached claim-complete payload: {entry.source}"
                )
            destination = output.joinpath(*PurePosixPath(entry.source).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as handle:
                handle.write(generated[entry.source])

        bootstrap_bytes = _bootstrap_allowlist(profile, generated)
        if bootstrap_allowlist_output is not None:
            with bootstrap_allowlist_output.open("xb") as handle:
                handle.write(bootstrap_bytes)

        try:
            subject_binding.assert_subject_snapshot_unchanged(subject_snapshot)
        except subject_binding.SubjectBindingError as exc:
            raise DerivationError(str(exc)) from exc

        created = False
        return {
            "status": "PASS" if allowlist is not None else "BOOTSTRAP_ONLY",
            "candidate_status": STATUS,
            "approval": APPROVAL,
            **subject_snapshot.binding.public_fields(),
            "subject_binding_verified": True,
            "claim_ids": list(CLAIM_IDS),
            "staged_file_count": len(generated),
            "staged_total_bytes": sum(len(data) for data in generated.values()),
            "profile_sha256": profile.raw_sha256,
            "allowlist_sha256": (
                _sha256(allowlist_bytes) if allowlist_bytes is not None else None
            ),
            "allowlist_validation": (
                "PASS_HASH_PINNED_EXCEPT_SUBJECT_BOUND_RECEIPT"
                if allowlist is not None
                else "BOOTSTRAP_ONLY_NOT_HASH_PINNED"
            ),
            "observed_allowlist_sha256": _sha256(bootstrap_bytes),
            "descriptive_only_destinations": list(
                profile.descriptive_only_destinations
            ),
        }
    finally:
        if created and output.exists() and not output.is_symlink():
            shutil.rmtree(output)


def _default_profile() -> Path:
    return Path(__file__).with_name("claim_complete_profile.json")


def _default_allowlist() -> Path:
    return Path(__file__).with_name("supplement_claim_complete_allowlist.json")


def _default_source_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Derive the hash-pinned anonymous C1-C10 supplement staging tree."
    )
    parser.add_argument("--source-root", type=Path, default=_default_source_root())
    parser.add_argument("--profile", type=Path, default=_default_profile())
    parser.add_argument("--allowlist", type=Path, default=_default_allowlist())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--subject-commit", required=True)
    parser.add_argument("--subject-tree", required=True)
    parser.add_argument(
        "--bootstrap-allowlist-output",
        type=Path,
        help="write an observed allowlist to a new non-repository bootstrap path",
    )
    parser.add_argument(
        "--without-allowlist-check",
        action="store_true",
        help="bootstrap only: derive from the profile before the checked-in allowlist exists",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = derive_payload(
            args.source_root,
            args.profile,
            args.output,
            None if args.without_allowlist_check else args.allowlist,
            args.subject_commit,
            args.subject_tree,
            args.bootstrap_allowlist_output,
        )
        rendered = _pretty_json(result)
    except (builder.CandidateError, DerivationError) as exc:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "candidate_status": STATUS,
                    "approval": APPROVAL,
                    "error": str(exc),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
                allow_nan=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
