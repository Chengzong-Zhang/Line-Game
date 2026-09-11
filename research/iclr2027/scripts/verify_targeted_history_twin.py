#!/usr/bin/env python3
"""Independently replay and verify a natural Superko history-twin candidate.

The verifier intentionally does not import the search implementation or its
goal predicate.  Both histories are replayed from the standard n-player initial
state through the public Python engine.  PASS certifies only an exact
mask-free-topology legality witness; it does not establish a learning benefit,
shortest path, or global search result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402


Action = tuple[int, int]
MaybePass = Action | None
History = tuple[MaybePass, ...]

FIXTURE_PATH = PROJECT_ROOT / "state_aliasing" / "superko_n6_witness_v1.json"
EXPECTED_FIXTURE_SHA256 = (
    "A2916486D2A9C4738B1B8A01F72A91A689F968E20D1B6673B5E4F05A15927155"
)
CORE_PATH = PROJECT_ROOT / "lifeline_rl" / "core.py"
SEARCH_PATH = PROJECT_ROOT / "scripts" / "search_targeted_history_twin.py"
WEB_WITNESS_PATH = (
    PROJECT_ROOT.parent.parent
    / "web"
    / "web前端"
    / "guide"
    / "interesting"
    / "verify-superko-history-divergence.mjs"
)
EXPECTED_WEB_WITNESS_SHA256 = (
    "A9356765AA5F9938AED14EF9B7409C2E2E501E2F69F4D6D855F13C481E2B7FB2"
)
WEB_ENGINE_PATH = PROJECT_ROOT.parent.parent / "web" / "web前端" / "GameEngine.js"
EXPECTED_WEB_ENGINE_SHA256 = (
    "48317759E700DF1FCEFF97651BC1BA10EF07FA43EEDDF081473B0C02AA03B173"
)
WEB_TARGET_VERIFIER_PATH = (
    PROJECT_ROOT / "scripts" / "verify_targeted_history_twin_web.mjs"
)

# Existing tracked Web verifier positive control.  Reference is the history
# containing the repeated key; twin is the history without it.
WEB_REFERENCE_HISTORY: History = (
    (1, 0),
    (4, 1),
    (0, 4),
    (1, 1),
    (3, 1),
    (1, 4),
    (1, 2),
    (1, 3),
    (3, 2),
)
WEB_TWIN_HISTORY: History = (
    (1, 0),
    (4, 1),
    (1, 2),
    (1, 4),
    (0, 4),
    (2, 3),
    (3, 2),
)
WEB_CANDIDATE_ACTION: Action = (1, 1)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest().upper()


def _json_action(action: MaybePass) -> list[int] | None:
    return None if action is None else [int(action[0]), int(action[1])]


def _parse_history(raw: Iterable[Sequence[int] | None], label: str) -> History:
    parsed: list[MaybePass] = []
    for index, item in enumerate(raw):
        if item is None:
            parsed.append(None)
            continue
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError(f"{label} action {index} is not a point or PASS")
        if type(item[0]) is not int or type(item[1]) is not int:
            raise ValueError(
                f"{label} action {index} coordinates must be strict integers"
            )
        parsed.append((item[0], item[1]))
    return tuple(parsed)


def _replay_standard(grid_size: int, history: History, label: str) -> LifelineGame:
    game = LifelineGame(grid_size, start_player=Player.BLACK, superko_mode="enforce")
    for ply, action in enumerate(history):
        outcome = game.skip_turn() if action is None else game.play_move(action)
        if not outcome.success:
            raise ValueError(
                f"{label} is not a natural legal replay at ply {ply}: "
                f"{action!r} ({outcome.reason})"
            )
    return game


def _topology_payload(game: LifelineGame) -> dict[str, Any]:
    return {
        "grid_size": game.grid_size,
        "board": list(game.grid),
        "current_player": game.current_player.value,
        "consecutive_skips": game.consecutive_skips,
        "game_over": game.game_over,
        "logical_edge_indices": {
            player.value: [list(edge) for edge in sorted(game.edges[player])]
            for player in (Player.BLACK, Player.WHITE)
        },
    }


def _history_fingerprint(game: LifelineGame) -> str:
    canonical = "\n".join(sorted(repr(key) for key in game.history_hashes))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().upper()


def _candidate_result_key(game: LifelineGame, action: Action) -> Any:
    probe = LifelineGame(
        game.grid_size,
        start_player=Player.BLACK,
        superko_mode="enforce",
    )
    probe.restore(game.clone())
    actor = probe.current_player
    if not probe._add_node(action):
        raise ValueError("candidate fails a non-Superko local placement rule")
    return probe._compute_state_key(probe.opponent(actor))


def _state_key_sha256(key: Any) -> str:
    return hashlib.sha256(repr(key).encode("utf-8")).hexdigest().upper()


def build_existing_web_candidate() -> dict[str, Any]:
    actual_source_sha256 = _sha256_file(WEB_WITNESS_PATH)
    if actual_source_sha256 != EXPECTED_WEB_WITNESS_SHA256:
        raise ValueError(
            "tracked Web witness source SHA-256 mismatch: "
            f"expected {EXPECTED_WEB_WITNESS_SHA256}, observed {actual_source_sha256}"
        )
    actual_engine_sha256 = _sha256_file(WEB_ENGINE_PATH)
    if actual_engine_sha256 != EXPECTED_WEB_ENGINE_SHA256:
        raise ValueError(
            "tracked Web GameEngine SHA-256 mismatch: "
            f"expected {EXPECTED_WEB_ENGINE_SHA256}, observed {actual_engine_sha256}"
        )
    return {
        "schema_version": 1,
        "artifact_kind": "existing_tracked_web_history_twin_candidate",
        "evidence_tier": "candidate_only_existing_source_replay",
        "input_binding": {
            "source_path": WEB_WITNESS_PATH.relative_to(
                PROJECT_ROOT.parent.parent
            ).as_posix(),
            "source_sha256": actual_source_sha256,
            "expected_source_sha256": EXPECTED_WEB_WITNESS_SHA256,
            "web_engine_path": WEB_ENGINE_PATH.relative_to(
                PROJECT_ROOT.parent.parent
            ).as_posix(),
            "web_engine_sha256": actual_engine_sha256,
            "expected_web_engine_sha256": EXPECTED_WEB_ENGINE_SHA256,
            "engine_core_path": CORE_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "engine_core_sha256": _sha256_file(CORE_PATH),
        },
        "result": {
            "status": "FOUND_CANDIDATE",
            "witness": {
                "classification": (
                    "candidate_natural_same_topology_different_history_superko_legality"
                ),
                "grid_size": 6,
                "reference_history": [
                    _json_action(action) for action in WEB_REFERENCE_HISTORY
                ],
                "twin_history": [_json_action(action) for action in WEB_TWIN_HISTORY],
                "candidate_action": list(WEB_CANDIDATE_ACTION),
            },
        },
        "claim_boundary": {
            "candidate_is_independently_verified": False,
            "source_document_is_formal_receipt": False,
        },
    }


def run_tracked_web_replay(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("artifact_kind") != "existing_tracked_web_history_twin_candidate":
        raise ValueError(
            "tracked Web replay is defined only for the existing strict-pair candidate"
        )
    completed = subprocess.run(
        ["node", str(WEB_WITNESS_PATH)],
        cwd=PROJECT_ROOT.parent.parent,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"tracked Web verifier failed with exit {completed.returncode}: {stderr}"
        )
    if completed.stderr:
        raise RuntimeError("tracked Web verifier wrote unexpected stderr")
    try:
        web_payload = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "tracked Web verifier did not emit strict UTF-8 JSON"
        ) from exc
    pair = web_payload.get("reachableHistoryPair")
    if not isinstance(pair, dict):
        raise RuntimeError("tracked Web verifier output has no reachableHistoryPair")
    witness = payload["result"]["witness"]
    expected_reference = _parse_history(
        witness["reference_history"], "reference_history"
    )
    expected_twin = _parse_history(witness["twin_history"], "twin_history")
    expected_action = tuple(witness["candidate_action"])
    observed_reference = _parse_history(pair["withKeyHistory"], "web_withKeyHistory")
    observed_twin = _parse_history(pair["withoutKeyHistory"], "web_withoutKeyHistory")
    observed_action = tuple(pair["candidate"])
    if (
        observed_reference != expected_reference
        or observed_twin != expected_twin
        or observed_action != expected_action
    ):
        raise RuntimeError(
            "tracked Web verifier replayed different histories or action"
        )
    without = pair.get("withoutKeyEvaluation")
    with_key = pair.get("withKeyEvaluation")
    if not isinstance(without, dict) or not isinstance(with_key, dict):
        raise RuntimeError("tracked Web verifier omitted candidate outcomes")
    if without.get("legal") is not True:
        raise RuntimeError("tracked Web verifier did not accept the twin candidate")
    if (
        with_key.get("legal") is not False
        or with_key.get("reason") != "SUPERKO_VIOLATION"
    ):
        raise RuntimeError(
            "tracked Web verifier did not reject the reference exactly by Superko"
        )
    legal = pair.get("legalPlacements")
    if not isinstance(legal, dict):
        raise RuntimeError("tracked Web verifier omitted legal placements")
    without_moves = {tuple(action) for action in legal.get("withoutKey", [])}
    with_moves = {tuple(action) for action in legal.get("withKey", [])}
    if with_moves - without_moves or without_moves - with_moves != {expected_action}:
        raise RuntimeError(
            "tracked Web legal-set difference is not exactly the candidate"
        )
    if pair.get("sameRulesKernel") is not True:
        raise RuntimeError("tracked Web verifier did not confirm the same rule kernel")
    node_version = (
        subprocess.run(
            ["node", "--version"],
            cwd=PROJECT_ROOT.parent.parent,
            capture_output=True,
            check=True,
            timeout=10,
        )
        .stdout.decode("ascii")
        .strip()
    )
    return {
        "status": "PASS",
        "node_version": node_version,
        "same_rules_kernel": True,
        "reference_history": [_json_action(action) for action in observed_reference],
        "twin_history": [_json_action(action) for action in observed_twin],
        "candidate_action": list(observed_action),
        "reference_reason": with_key["reason"],
        "twin_legal": True,
        "legal_only_in_twin": [list(expected_action)],
        "web_stdout_sha256": hashlib.sha256(completed.stdout).hexdigest().upper(),
        "input_model": (
            "The tracked Web verifier and Python candidate retain matching embedded histories; "
            "they do not consume a newly shared fixture."
        ),
    }


def run_targeted_web_replay(
    payload: dict[str, Any], candidate_path: Path
) -> dict[str, Any]:
    if payload.get("artifact_kind") != "targeted_history_twin_search_candidate":
        raise ValueError("targeted Web replay requires a targeted search candidate")
    candidate_bytes = candidate_path.read_bytes()
    completed = subprocess.run(
        ["node", str(WEB_TARGET_VERIFIER_PATH), str(candidate_path)],
        cwd=PROJECT_ROOT.parent.parent,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"targeted Web verifier failed with exit {completed.returncode}: {stderr}"
        )
    if completed.stderr:
        raise RuntimeError("targeted Web verifier wrote unexpected stderr")
    try:
        web_receipt = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "targeted Web verifier did not emit strict UTF-8 JSON"
        ) from exc
    if web_receipt.get("status") != "PASS":
        raise RuntimeError("targeted Web verifier did not return PASS")
    candidate_sha256 = hashlib.sha256(candidate_bytes).hexdigest().upper()
    if web_receipt.get("candidate_sha256") != candidate_sha256:
        raise RuntimeError("targeted Web receipt candidate hash is wrong")
    if web_receipt.get("web_engine_sha256") != EXPECTED_WEB_ENGINE_SHA256:
        raise RuntimeError("targeted Web receipt engine hash is wrong")
    if web_receipt.get("web_verifier_sha256") != _sha256_file(WEB_TARGET_VERIFIER_PATH):
        raise RuntimeError("targeted Web receipt verifier hash is wrong")
    witness = payload["result"]["witness"]
    if web_receipt.get("candidate_action") != witness.get("candidate_action"):
        raise RuntimeError("targeted Web receipt action differs from candidate")
    if web_receipt.get("target_topology") != witness.get("target_topology"):
        raise RuntimeError("targeted Web receipt topology differs from candidate")
    if web_receipt.get("reference_reason") != "SUPERKO_VIOLATION":
        raise RuntimeError("targeted Web receipt reference reason is wrong")
    if web_receipt.get("twin_legal") is not True:
        raise RuntimeError("targeted Web receipt did not accept the twin")
    if web_receipt.get("legal_only_in_reference") != []:
        raise RuntimeError("targeted Web receipt has an extra reference-legal action")
    if web_receipt.get("legal_only_in_twin") != [witness["candidate_action"]]:
        raise RuntimeError(
            "targeted Web legal-set difference is not exactly the candidate"
        )
    web_receipt["node_version"] = (
        subprocess.run(
            ["node", "--version"],
            cwd=PROJECT_ROOT.parent.parent,
            capture_output=True,
            check=True,
            timeout=10,
        )
        .stdout.decode("ascii")
        .strip()
    )
    web_receipt["web_stdout_sha256"] = (
        hashlib.sha256(completed.stdout).hexdigest().upper()
    )
    return web_receipt


def _validate_input_binding(
    payload: dict[str, Any], candidate_path: Path | None
) -> None:
    binding = payload.get("input_binding")
    if not isinstance(binding, dict):
        raise ValueError("candidate has no input binding")
    if binding.get("engine_core_sha256") != _sha256_file(CORE_PATH):
        raise ValueError("candidate engine-core SHA-256 does not match current bytes")

    kind = payload.get("artifact_kind")
    if kind == "targeted_history_twin_search_candidate":
        if payload.get("result", {}).get("status") != "FOUND_CANDIDATE":
            raise ValueError("bounded search output did not find a candidate")
        if _sha256_file(FIXTURE_PATH) != EXPECTED_FIXTURE_SHA256:
            raise ValueError("frozen target fixture bytes changed")
        if binding.get("fixture_sha256") != EXPECTED_FIXTURE_SHA256:
            raise ValueError("search candidate is not bound to the frozen fixture")
        if binding.get("expected_fixture_sha256") != EXPECTED_FIXTURE_SHA256:
            raise ValueError("search candidate expected-fixture binding is wrong")
        if binding.get("fixture_id") != "natural_superko_n6_witness_v1":
            raise ValueError("search candidate fixture id is wrong")
        if binding.get("fixture_path") != "state_aliasing/superko_n6_witness_v1.json":
            raise ValueError("search candidate fixture path is wrong")
        if binding.get("search_script_sha256") != _sha256_file(SEARCH_PATH):
            raise ValueError(
                "search candidate script SHA-256 does not match current bytes"
            )
    elif kind == "existing_tracked_web_history_twin_candidate":
        if _sha256_file(WEB_WITNESS_PATH) != EXPECTED_WEB_WITNESS_SHA256:
            raise ValueError("tracked Web witness source bytes changed")
        if binding.get("source_sha256") != EXPECTED_WEB_WITNESS_SHA256:
            raise ValueError("existing-source candidate has the wrong source binding")
        if binding.get("expected_source_sha256") != EXPECTED_WEB_WITNESS_SHA256:
            raise ValueError(
                "existing-source candidate expected-source binding is wrong"
            )
        if binding.get("source_path") != (
            "web/web前端/guide/interesting/verify-superko-history-divergence.mjs"
        ):
            raise ValueError("existing-source candidate source path is wrong")
        if _sha256_file(WEB_ENGINE_PATH) != EXPECTED_WEB_ENGINE_SHA256:
            raise ValueError("tracked Web GameEngine bytes changed")
        if binding.get("web_engine_sha256") != EXPECTED_WEB_ENGINE_SHA256:
            raise ValueError("existing-source candidate Web engine binding is wrong")
        if binding.get("expected_web_engine_sha256") != EXPECTED_WEB_ENGINE_SHA256:
            raise ValueError(
                "existing-source candidate expected Web engine binding is wrong"
            )
        if binding.get("web_engine_path") != "web/web前端/GameEngine.js":
            raise ValueError("existing-source candidate Web engine path is wrong")
    else:
        origin = (
            str(candidate_path) if candidate_path is not None else "in-memory candidate"
        )
        raise ValueError(f"unsupported candidate artifact kind from {origin}: {kind!r}")


def verify_candidate_payload(
    payload: dict[str, Any],
    *,
    candidate_path: Path | None = None,
    candidate_file_sha256: str | None = None,
    web_replay: dict[str, Any] | None = None,
) -> dict[str, Any]:
    initial_source_hashes = {
        "engine_core": _sha256_file(CORE_PATH),
        "frozen_fixture": _sha256_file(FIXTURE_PATH),
        "tracked_web_source": _sha256_file(WEB_WITNESS_PATH),
        "tracked_web_engine": _sha256_file(WEB_ENGINE_PATH),
        "targeted_web_verifier": _sha256_file(WEB_TARGET_VERIFIER_PATH),
        "verifier": _sha256_file(Path(__file__)),
    }
    if payload.get("schema_version") != 1:
        raise ValueError("candidate schema version must be 1")
    _validate_input_binding(payload, candidate_path)
    result = payload.get("result")
    witness = result.get("witness") if isinstance(result, dict) else None
    if not isinstance(witness, dict):
        raise ValueError("candidate has no witness payload")
    if witness.get("classification") != (
        "candidate_natural_same_topology_different_history_superko_legality"
    ):
        raise ValueError("candidate witness classification is unsupported")

    raw_grid_size = witness.get(
        "grid_size", payload.get("target", {}).get("grid_size", 0)
    )
    if type(raw_grid_size) is not int:
        raise ValueError("candidate grid size must be a strict integer")
    grid_size = raw_grid_size
    if grid_size != 6:
        raise ValueError("current verifier contract requires grid size 6")
    reference_history = _parse_history(
        witness["reference_history"], "reference_history"
    )
    twin_history = _parse_history(witness["twin_history"], "twin_history")
    candidate_action_raw = witness["candidate_action"]
    if (
        not isinstance(candidate_action_raw, (list, tuple))
        or len(candidate_action_raw) != 2
    ):
        raise ValueError("candidate action is not a point")
    if (
        type(candidate_action_raw[0]) is not int
        or type(candidate_action_raw[1]) is not int
    ):
        raise ValueError("candidate action coordinates must be strict integers")
    candidate_action = (candidate_action_raw[0], candidate_action_raw[1])
    if reference_history == twin_history:
        raise ValueError("candidate histories are identical")

    if payload["artifact_kind"] == "existing_tracked_web_history_twin_candidate":
        if (
            reference_history != WEB_REFERENCE_HISTORY
            or twin_history != WEB_TWIN_HISTORY
            or candidate_action != WEB_CANDIDATE_ACTION
        ):
            raise ValueError(
                "existing-source candidate differs from the tracked strict pair"
            )
    else:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        expected_reference = _parse_history(
            fixture["natural_prefix"]["actions"],
            "frozen_fixture_reference_history",
        )
        expected_candidate_raw = fixture["candidate"]["action"]
        expected_candidate = (expected_candidate_raw[0], expected_candidate_raw[1])
        if (
            reference_history != expected_reference
            or candidate_action != expected_candidate
        ):
            raise ValueError(
                "search candidate reference/action differs from the frozen target"
            )
        target_payload = payload.get("target")
        if not isinstance(target_payload, dict):
            raise ValueError("search candidate has no target binding")
        if target_payload.get("grid_size") != grid_size:
            raise ValueError("search candidate target grid size is wrong")
        if target_payload.get("candidate_action") != list(expected_candidate):
            raise ValueError("search candidate top-level action is wrong")
        if target_payload.get("reference_history") != [
            _json_action(action) for action in expected_reference
        ]:
            raise ValueError("search candidate top-level reference history is wrong")

    reference = _replay_standard(grid_size, reference_history, "reference_history")
    twin = _replay_standard(grid_size, twin_history, "twin_history")
    topology_reference = _topology_payload(reference)
    topology_twin = _topology_payload(twin)
    if topology_reference != topology_twin:
        raise ValueError("replayed histories do not reach the same mask-free topology")
    if reference.history_hashes == twin.history_hashes:
        raise ValueError(
            "replayed histories do not have different Superko history sets"
        )

    if payload["artifact_kind"] == "targeted_history_twin_search_candidate":
        target_payload = payload["target"]
        if target_payload.get("target_topology") != topology_reference:
            raise ValueError(
                "search candidate topology differs from the frozen replay target"
            )
        if target_payload.get("target_topology_sha256") != _canonical_sha256(
            topology_reference
        ):
            raise ValueError(
                "search candidate topology digest differs from frozen replay"
            )
        if target_payload.get("reference_state_fingerprint") != (
            reference.state_fingerprint().upper()
        ):
            raise ValueError("search candidate reference state fingerprint is wrong")
        if target_payload.get("reference_history_fingerprint") != _history_fingerprint(
            reference
        ):
            raise ValueError("search candidate reference history fingerprint is wrong")

    reference_outcome = reference.evaluate_move(candidate_action)
    twin_outcome = twin.evaluate_move(candidate_action)
    if (
        reference_outcome.success
        or reference_outcome.reason != "SUPERKO_VIOLATION"
        or not reference_outcome.would_violate_superko
    ):
        raise ValueError("reference candidate is not rejected exactly by Superko")
    if not twin_outcome.success or twin_outcome.reason is not None:
        raise ValueError("twin candidate is not legal")
    if twin_outcome.would_violate_superko:
        raise ValueError("legal twin candidate unexpectedly reports a repeated key")

    result_key_reference = _candidate_result_key(reference, candidate_action)
    result_key_twin = _candidate_result_key(twin, candidate_action)
    if result_key_reference != result_key_twin:
        raise ValueError("same-topology candidate produced different rule-state keys")
    if result_key_reference not in reference.history_hashes:
        raise ValueError("candidate result key is absent from reference history")
    if result_key_twin in twin.history_hashes:
        raise ValueError("candidate result key is unexpectedly present in twin history")
    if payload["artifact_kind"] == "targeted_history_twin_search_candidate":
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        expected_result_key_sha256 = str(
            fixture["stage_5"]["position_key_sha256"]
        ).upper()
        observed_result_key_sha256 = _state_key_sha256(result_key_reference)
        if observed_result_key_sha256 != expected_result_key_sha256:
            raise ValueError("search candidate result key differs from frozen target")
        if payload["target"].get("forbidden_key_sha256") != expected_result_key_sha256:
            raise ValueError("search candidate top-level forbidden-key digest is wrong")
        required_witness_fields = {
            "target_topology",
            "target_topology_sha256",
            "reference_state_fingerprint",
            "twin_state_fingerprint",
            "reference_history_fingerprint",
            "twin_history_fingerprint",
            "forbidden_key_sha256",
        }
        missing = sorted(required_witness_fields - set(witness))
        if missing:
            raise ValueError(f"search candidate witness fields are missing: {missing}")

    topology_sha256 = _canonical_sha256(topology_reference)
    optional_checks = {
        "target_topology_sha256": topology_sha256,
        "reference_state_fingerprint": reference.state_fingerprint().upper(),
        "twin_state_fingerprint": twin.state_fingerprint().upper(),
        "reference_history_fingerprint": _history_fingerprint(reference),
        "twin_history_fingerprint": _history_fingerprint(twin),
        "forbidden_key_sha256": _state_key_sha256(result_key_reference),
    }
    for key, observed in optional_checks.items():
        declared = witness.get(key)
        if declared is not None and str(declared).upper() != observed:
            raise ValueError(f"candidate witness field {key!r} does not replay")
    declared_topology = witness.get("target_topology")
    if declared_topology is not None and declared_topology != topology_reference:
        raise ValueError("candidate target topology bytes do not replay")

    reference_legal = set(reference.legal_moves())
    twin_legal = set(twin.legal_moves())
    legal_only_in_reference = sorted(reference_legal - twin_legal)
    legal_only_in_twin = sorted(twin_legal - reference_legal)
    if candidate_action not in legal_only_in_twin:
        raise ValueError(
            "candidate action is not exposed by the replayed legal-set difference"
        )
    if legal_only_in_reference or legal_only_in_twin != [candidate_action]:
        raise ValueError(
            "legal-set difference contains actions other than the candidate"
        )

    candidate_digest = (
        candidate_file_sha256
        if candidate_file_sha256 is not None
        else _canonical_sha256(payload)
    )
    final_source_hashes = {
        "engine_core": _sha256_file(CORE_PATH),
        "frozen_fixture": _sha256_file(FIXTURE_PATH),
        "tracked_web_source": _sha256_file(WEB_WITNESS_PATH),
        "tracked_web_engine": _sha256_file(WEB_ENGINE_PATH),
        "targeted_web_verifier": _sha256_file(WEB_TARGET_VERIFIER_PATH),
        "verifier": _sha256_file(Path(__file__)),
    }
    if final_source_hashes != initial_source_hashes:
        raise RuntimeError("a verifier input changed during replay")

    if candidate_path is None:
        portable_candidate_path = None
    else:
        resolved_candidate_path = candidate_path.resolve()
        try:
            portable_candidate_path = resolved_candidate_path.relative_to(
                PROJECT_ROOT.parent.parent
            ).as_posix()
        except ValueError:
            portable_candidate_path = resolved_candidate_path.name
    return {
        "schema_version": 1,
        "artifact_kind": "independent_natural_history_twin_verification_receipt",
        "status": "PASS",
        "ok": True,
        "candidate_binding": {
            "candidate_path": portable_candidate_path,
            "candidate_sha256": candidate_digest,
            "candidate_artifact_kind": payload["artifact_kind"],
        },
        "source_binding": {
            "engine_core_path": CORE_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "engine_core_sha256": initial_source_hashes["engine_core"],
            "verifier_path": Path(__file__).relative_to(PROJECT_ROOT).as_posix(),
            "verifier_sha256": initial_source_hashes["verifier"],
            "frozen_fixture_path": FIXTURE_PATH.relative_to(PROJECT_ROOT).as_posix(),
            "frozen_fixture_sha256": initial_source_hashes["frozen_fixture"],
            "tracked_web_source_path": WEB_WITNESS_PATH.relative_to(
                PROJECT_ROOT.parent.parent
            ).as_posix(),
            "tracked_web_source_sha256": initial_source_hashes["tracked_web_source"],
            "tracked_web_engine_path": WEB_ENGINE_PATH.relative_to(
                PROJECT_ROOT.parent.parent
            ).as_posix(),
            "tracked_web_engine_sha256": initial_source_hashes["tracked_web_engine"],
            "targeted_web_verifier_path": WEB_TARGET_VERIFIER_PATH.relative_to(
                PROJECT_ROOT
            ).as_posix(),
            "targeted_web_verifier_sha256": initial_source_hashes[
                "targeted_web_verifier"
            ],
        },
        "verified_witness": {
            "grid_size": grid_size,
            "standard_initial_state_replay": True,
            "start_player": Player.BLACK.value,
            "superko_mode": "enforce",
            "reference_history": [_json_action(action) for action in reference_history],
            "twin_history": [_json_action(action) for action in twin_history],
            "candidate_action": list(candidate_action),
            "same_mask_free_topology": True,
            "different_superko_history_sets": True,
            "target_topology": topology_reference,
            "target_topology_sha256": topology_sha256,
            "reference_state_fingerprint": reference.state_fingerprint().upper(),
            "twin_state_fingerprint": twin.state_fingerprint().upper(),
            "reference_history_fingerprint": _history_fingerprint(reference),
            "twin_history_fingerprint": _history_fingerprint(twin),
            "reference_history_key_count": len(reference.history_hashes),
            "twin_history_key_count": len(twin.history_hashes),
            "candidate_result_key_sha256": _state_key_sha256(result_key_reference),
            "candidate_result_key_in_reference_history": True,
            "candidate_result_key_in_twin_history": False,
            "reference_outcome": asdict(reference_outcome),
            "twin_outcome": asdict(twin_outcome),
            "legal_only_in_reference": [
                list(action) for action in legal_only_in_reference
            ],
            "legal_only_in_twin": [list(action) for action in legal_only_in_twin],
        },
        "claim_boundary": {
            "natural_reachability_verified": True,
            "decision_relevant_superko_legality_witness_verified": True,
            "equal_projection": (
                "board, logical edges, current player, consecutive skips, terminal flag"
            ),
            "implemented_mask_bearing_topology_observation_equal": False,
            "learning_performance_effect_claimed": False,
            "shortest_history_claimed": False,
            "global_search_exhaustiveness_claimed": False,
            "same_backbone_ablation_claimed": False,
            "cross_engine_replay_verified": web_replay is not None,
            "verification_independence": (
                "Search-independent Python replay. When cross_engine_replay_verified is true, "
                "the receipt also executed the tracked Web verifier and compared its structured "
                "histories, action, topology-kernel equality, outcomes, and legal-set difference. "
                "The cross_engine_replay.input_model field states whether both implementations "
                "consumed the same persisted candidate or retained separate embedded inputs."
            ),
        },
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "cpu_only": True,
            "network_used": False,
        },
        "cross_engine_replay": web_replay,
    }


def verify_candidate_file(
    path: Path, *, require_web_replay: bool = False
) -> dict[str, Any]:
    raw = path.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("candidate is not strict UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("candidate root must be an object")
    web_replay = None
    if require_web_replay:
        if payload.get("artifact_kind") == "targeted_history_twin_search_candidate":
            web_replay = run_targeted_web_replay(payload, path.resolve())
        else:
            web_replay = run_tracked_web_replay(payload)
    return verify_candidate_payload(
        payload,
        candidate_path=path.resolve(),
        candidate_file_sha256=hashlib.sha256(raw).hexdigest().upper(),
        web_replay=web_replay,
    )


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _write_receipt(path: Path, receipt: dict[str, Any]) -> None:
    resolved = path.resolve()
    forbidden_roots = (
        (PROJECT_ROOT / "state_aliasing").resolve(),
        (PROJECT_ROOT / "results" / "formal").resolve(),
    )
    if any(_is_relative_to(resolved, root) for root in forbidden_roots):
        raise ValueError(
            "verification receipt may not be written into frozen/formal evidence roots"
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)


def _write_candidate(path: Path, candidate: dict[str, Any]) -> None:
    resolved = path.resolve()
    if _is_relative_to(
        resolved, (PROJECT_ROOT / "state_aliasing").resolve()
    ) or _is_relative_to(
        resolved,
        (PROJECT_ROOT / "results" / "formal").resolve(),
    ):
        raise ValueError(
            "candidate may not be written into frozen/formal evidence roots"
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(candidate, indent=2, sort_keys=True) + "\n"
    with resolved.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--candidate", type=Path)
    source.add_argument(
        "--existing-web-pair",
        action="store_true",
        help="independently replay the strict pair already present in the tracked Web verifier",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--candidate-output",
        type=Path,
        help="create-only path for the existing tracked Web-pair candidate",
    )
    parser.add_argument(
        "--require-web-replay",
        action="store_true",
        help="execute and compare the tracked Web verifier in addition to Python replay",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.candidate_output is not None and not args.existing_web_pair:
        raise SystemExit("--candidate-output requires --existing-web-pair")
    if args.existing_web_pair:
        candidate = build_existing_web_candidate()
        if args.candidate_output is not None:
            _write_candidate(args.candidate_output, candidate)
            receipt = verify_candidate_file(
                args.candidate_output,
                require_web_replay=True,
            )
        else:
            web_replay = run_tracked_web_replay(candidate)
            receipt = verify_candidate_payload(candidate, web_replay=web_replay)
    else:
        receipt = verify_candidate_file(
            args.candidate,
            require_web_replay=args.require_web_replay,
        )
    if args.output is not None:
        _write_receipt(args.output, receipt)
    else:
        sys.stdout.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
