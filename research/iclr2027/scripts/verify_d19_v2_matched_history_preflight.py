#!/usr/bin/env python3
"""CPU-only verifier for the append-only D19-v2 matched feature contract."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Mapping


RESEARCH_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = RESEARCH_ROOT.parents[1]
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame  # noqa: E402
from scripts.d19_v2_matched_history_contract import (  # noqa: E402
    ARM_FEATURES,
    BASE_NODE_FEATURES,
    EXPECTED_TRAINABLE_PARAMETERS,
    MATCHED_NODE_FEATURES,
    ContractError,
    build_arm_batch,
    compact_history_plane,
    instantiate_matched_model,
    load_manifest,
    mask_free_topology,
    model_state_sha256,
    read_json,
    replay_actions,
    resolve_repo_path,
    sha256_file,
)


DEFAULT_MANIFEST_PATH = (
    RESEARCH_ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
)
INITIALIZATION_PREFLIGHT_SEED = 202608250019


def _strict_action(raw: object, label: str) -> tuple[int, int]:
    if (
        not isinstance(raw, list)
        or len(raw) != 2
        or not all(
            isinstance(value, int) and not isinstance(value, bool) for value in raw
        )
    ):
        raise ContractError(f"{label} must contain two strict integers")
    return raw[0], raw[1]


def _load_witness(manifest: Mapping[str, Any]) -> dict[str, Any]:
    boundary = manifest.get("witness_boundary")
    if not isinstance(boundary, Mapping):
        raise ContractError("witness_boundary must be an object")
    candidate_path = resolve_repo_path(boundary.get("candidate_path"))
    receipt_path = resolve_repo_path(boundary.get("verification_path"))
    if sha256_file(candidate_path) != boundary.get("candidate_sha256"):
        raise ContractError("D19-v2 witness candidate SHA-256 mismatch")
    if sha256_file(receipt_path) != boundary.get("verification_sha256"):
        raise ContractError("D19-v2 witness verification SHA-256 mismatch")

    candidate = read_json(candidate_path)
    receipt = read_json(receipt_path)
    if receipt.get("status") != "PASS" or receipt.get("ok") is not True:
        raise ContractError("D19-v2 witness receipt is not a PASS receipt")
    receipt_claims = receipt.get("claim_boundary")
    if not isinstance(receipt_claims, Mapping):
        raise ContractError("D19-v2 witness receipt lacks claim boundaries")
    if (
        receipt_claims.get("implemented_mask_bearing_topology_observation_equal")
        is not False
    ):
        raise ContractError("witness receipt must keep mask-bearing equality false")
    if receipt_claims.get("same_backbone_ablation_claimed") is not False:
        raise ContractError("witness receipt may not claim a same-backbone ablation")

    result = candidate.get("result")
    witness = result.get("witness") if isinstance(result, Mapping) else None
    if not isinstance(witness, Mapping):
        raise ContractError("candidate does not contain a witness")
    grid_size = candidate.get("target", {}).get("grid_size")
    if grid_size != 6:
        raise ContractError("D19-v2 preflight expects the bound n=6 witness")
    action = _strict_action(witness.get("candidate_action"), "candidate action")
    if list(action) != boundary.get("candidate_action"):
        raise ContractError("candidate action differs from the D19-v2 binding")

    reference = replay_actions(grid_size, witness.get("reference_history", []))
    twin = replay_actions(grid_size, witness.get("twin_history", []))
    if reference.state_fingerprint().upper() != witness.get(
        "reference_state_fingerprint"
    ):
        raise ContractError("reference witness replay fingerprint mismatch")
    if twin.state_fingerprint().upper() != witness.get("twin_state_fingerprint"):
        raise ContractError("twin witness replay fingerprint mismatch")
    if mask_free_topology(reference) != mask_free_topology(twin):
        raise ContractError("bound witness no longer has equal mask-free topology")
    if reference.history_hashes == twin.history_hashes:
        raise ContractError("bound witness no longer has distinct histories")

    reference_outcome = reference.evaluate_move(action)
    twin_outcome = twin.evaluate_move(action)
    if (
        reference_outcome.success
        or reference_outcome.reason != "SUPERKO_VIOLATION"
        or not reference_outcome.would_violate_superko
        or not twin_outcome.success
        or twin_outcome.would_violate_superko
    ):
        raise ContractError("bound witness no longer has the declared Superko outcome")

    reference_legal = set(reference.legal_moves())
    twin_legal = set(twin.legal_moves())
    if reference_legal - twin_legal or twin_legal - reference_legal != {action}:
        raise ContractError(
            "bound witness legal-set difference is not exactly the action"
        )

    action_index = reference.point_to_index[action]
    reference_history = compact_history_plane(reference)
    twin_history = compact_history_plane(twin)
    history_difference = [
        index
        for index, (left, right) in enumerate(zip(reference_history, twin_history))
        if left != right
    ]
    if reference_history[action_index] != 1.0 or twin_history[action_index] != 0.0:
        raise ContractError("compact history plane does not expose the witness action")
    if history_difference != [action_index]:
        raise ContractError("witness history planes differ outside the declared action")

    return {
        "candidate_path": str(boundary["candidate_path"]),
        "candidate_sha256": str(boundary["candidate_sha256"]),
        "verification_path": str(boundary["verification_path"]),
        "verification_sha256": str(boundary["verification_sha256"]),
        "grid_size": grid_size,
        "candidate_action": list(action),
        "candidate_action_index": action_index,
        "reference": reference,
        "twin": twin,
        "reference_history_plane": reference_history,
        "twin_history_plane": twin_history,
    }


def _shape_signature(model: Any) -> list[dict[str, Any]]:
    return [
        {"name": name, "shape": list(tensor.shape), "dtype": str(tensor.dtype)}
        for name, tensor in sorted(model.state_dict().items())
    ]


def _tensor_checks(witness: Mapping[str, Any]) -> dict[str, Any]:
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - normal train env has torch
        raise ContractError("D19-v2 CPU tensor preflight requires PyTorch") from exc

    games = [
        witness["reference"],
        witness["twin"],
        LifelineGame(5),
        LifelineGame(9),
        LifelineGame(12),
    ]
    batches: dict[str, Any] = {}
    models: dict[str, Any] = {}
    state_digests: dict[str, str] = {}
    shape_signatures: dict[str, list[dict[str, Any]]] = {}
    parameter_counts: dict[str, int] = {}
    output_shapes: dict[str, dict[str, list[int]]] = {}

    outer_rng = torch.random.get_rng_state().clone()
    for arm_id, (logical_enabled, history_enabled) in ARM_FEATURES.items():
        batches[arm_id] = build_arm_batch(
            games,
            logical_edges_enabled=logical_enabled,
            compact_history_enabled=history_enabled,
        )
        model = instantiate_matched_model(INITIALIZATION_PREFLIGHT_SEED).eval()
        models[arm_id] = model
        if any(parameter.device.type != "cpu" for parameter in model.parameters()):
            raise ContractError("D19-v2 preflight model escaped the CPU")
        parameter_counts[arm_id] = model.parameter_count
        state_digests[arm_id] = model_state_sha256(model)
        shape_signatures[arm_id] = _shape_signature(model)
        batch = batches[arm_id]
        with torch.no_grad():
            logits, values = model(
                batch.node_features,
                batch.adjacency,
                batch.node_mask,
                batch.legal_action_mask,
            )
        if not bool(torch.isfinite(values).all()):
            raise ContractError(f"{arm_id} produced non-finite values")
        if not bool(torch.isfinite(logits[batch.legal_action_mask]).all()):
            raise ContractError(f"{arm_id} produced non-finite legal logits")
        probabilities = torch.softmax(logits, dim=1)
        if float(probabilities[~batch.legal_action_mask].sum()) != 0.0:
            raise ContractError(f"{arm_id} assigned mass to illegal actions")
        output_shapes[arm_id] = {
            "logits": list(logits.shape),
            "value": list(values.shape),
        }
    if not torch.equal(outer_rng, torch.random.get_rng_state()):
        raise ContractError("matched model construction perturbed the caller CPU RNG")

    if set(parameter_counts.values()) != {EXPECTED_TRAINABLE_PARAMETERS}:
        raise ContractError("four-arm exact parameter equality failed")
    if len(set(state_digests.values())) != 1:
        raise ContractError("same-seed initial parameter bytes differ across arms")
    canonical_shapes = next(iter(shape_signatures.values()))
    if any(signature != canonical_shapes for signature in shape_signatures.values()):
        raise ContractError("state-dict key/shape signatures differ across arms")

    full = batches["edge1_history1"]
    tensor_shape = {
        "node_features": list(full.node_features.shape),
        "adjacency": list(full.adjacency.shape),
        "node_mask": list(full.node_mask.shape),
        "legal_action_mask": list(full.legal_action_mask.shape),
    }
    for arm_id, (logical_enabled, history_enabled) in ARM_FEATURES.items():
        batch = batches[arm_id]
        if {
            "node_features": list(batch.node_features.shape),
            "adjacency": list(batch.adjacency.shape),
            "node_mask": list(batch.node_mask.shape),
            "legal_action_mask": list(batch.legal_action_mask.shape),
        } != tensor_shape:
            raise ContractError(f"{arm_id} tensor shapes differ from the full arm")
        if not torch.equal(
            batch.node_features[:, :, :BASE_NODE_FEATURES],
            full.node_features[:, :, :BASE_NODE_FEATURES],
        ):
            raise ContractError(f"{arm_id} changed a non-history node feature")
        if not torch.equal(batch.adjacency[:, 0], full.adjacency[:, 0]):
            raise ContractError(f"{arm_id} changed physical adjacency")
        if not torch.equal(batch.node_mask, full.node_mask):
            raise ContractError(f"{arm_id} changed node padding")
        if not torch.equal(batch.legal_action_mask, full.legal_action_mask):
            raise ContractError(f"{arm_id} changed the rules legal mask")
        if logical_enabled:
            if not torch.equal(batch.adjacency[:, 1:], full.adjacency[:, 1:]):
                raise ContractError(f"{arm_id} altered enabled logical relations")
        elif int(torch.count_nonzero(batch.adjacency[:, 1:]).item()) != 0:
            raise ContractError(f"{arm_id} did not zero both logical relations")
        if history_enabled:
            if not torch.equal(
                batch.node_features[:, :, -1], full.node_features[:, :, -1]
            ):
                raise ContractError(f"{arm_id} altered enabled compact history")
        elif int(torch.count_nonzero(batch.node_features[:, :, -1]).item()) != 0:
            raise ContractError(f"{arm_id} did not zero compact history")

    if int(torch.count_nonzero(full.adjacency[:2, 1:]).item()) <= 0:
        raise ContractError("witness batch does not exercise logical relations")
    action_index = int(witness["candidate_action_index"])
    if float(full.node_features[0, action_index, -1]) != 1.0:
        raise ContractError("reference witness history feature is not one")
    if float(full.node_features[1, action_index, -1]) != 0.0:
        raise ContractError("twin witness history feature is not zero")
    legal_difference = (
        torch.nonzero(full.legal_action_mask[0] != full.legal_action_mask[1])
        .flatten()
        .tolist()
    )
    if legal_difference != [action_index]:
        raise ContractError("witness legal masks do not differ exactly at the action")

    return {
        "torch_version": str(torch.__version__),
        "device": "cpu",
        "preflight_batch_grid_sizes": [5, 6, 9, 12],
        "preflight_batch_rows": len(games),
        "tensor_shape": tensor_shape,
        "matched_node_feature_width": MATCHED_NODE_FEATURES,
        "parameter_counts": parameter_counts,
        "state_dict_shape_entry_count": len(canonical_shapes),
        "same_seed_initial_state_sha256": next(iter(state_digests.values())),
        "state_dict_shapes_identical": True,
        "initial_parameter_bytes_identical": True,
        "physical_relations_identical": True,
        "base_node_features_identical": True,
        "legal_masks_identical_across_arms_for_each_position": True,
        "logical_axis_is_zero_only": True,
        "history_axis_is_zero_only": True,
        "output_shapes": output_shapes,
        "finite_cpu_forward": True,
        "illegal_action_probability_mass_zero": True,
        "backward_called": False,
        "optimizer_constructed": False,
    }


def run_preflight(manifest_path: str | Path = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    path = Path(manifest_path).resolve()
    manifest = load_manifest(path, verify_source_bindings=True)
    witness = _load_witness(manifest)
    tensors = _tensor_checks(witness)

    protocol_binding = next(
        binding
        for binding in manifest["source_bindings"]
        if binding["path"].endswith("D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md")
    )
    return {
        "schema_name": "lifeline-d19-v2-matched-history-cpu-preflight",
        "schema_version": 1,
        "status": "PASS",
        "experiment_id": manifest["experiment_id"],
        "evidence_tier": "cpu_contract_preflight_only",
        "manifest_binding": {
            "path": str(path.relative_to(REPO_ROOT.resolve())).replace("\\", "/"),
            "sha256": sha256_file(path),
        },
        "protocol_binding": copy.deepcopy(protocol_binding),
        "contract_script_sha256": sha256_file(
            RESEARCH_ROOT / "scripts" / "d19_v2_matched_history_contract.py"
        ),
        "verifier_script_sha256": sha256_file(Path(__file__).resolve()),
        "four_arm_factorial": {
            arm_id: {
                "logical_edges_enabled": features[0],
                "compact_history_enabled": features[1],
            }
            for arm_id, features in ARM_FEATURES.items()
        },
        "witness_check": {
            "candidate_path": witness["candidate_path"],
            "candidate_sha256": witness["candidate_sha256"],
            "verification_path": witness["verification_path"],
            "verification_sha256": witness["verification_sha256"],
            "grid_size": witness["grid_size"],
            "candidate_action": witness["candidate_action"],
            "candidate_action_index": witness["candidate_action_index"],
            "same_mask_free_topology": True,
            "different_complete_histories": True,
            "reference_compact_history_bit": 1,
            "twin_compact_history_bit": 0,
            "same_implemented_legal_mask": False,
        },
        "tensor_and_model_checks": tensors,
        "execution_counts": {
            "training_steps": 0,
            "optimizer_steps": 0,
            "self_play_games": 0,
            "evaluation_games": 0,
            "checkpoints": 0,
            "formal_results": 0,
            "gpu_operations": 0,
            "network_requests": 0,
        },
        "authorization": {
            "training_authorized": False,
            "evaluation_authorized": False,
            "gpu_authorized": False,
        },
        "claim_boundary": {
            "tensor_contract_prepared": True,
            "learning_effect_claimed": False,
            "topology_history_superiority_claimed": False,
            "same_observation_and_mask_decision_witness_claimed": False,
            "construct_validity_blocker_status": "OPEN",
            "old_d19_v1_gate_status": "CLOSED",
            "formal_result_status": "ABSENT",
        },
    }


def write_receipt(path: str | Path, payload: Mapping[str, Any]) -> None:
    output = Path(path).resolve()
    formal_root = (RESEARCH_ROOT / "results" / "formal").resolve()
    try:
        output.relative_to(formal_root)
    except ValueError:
        pass
    else:
        raise ContractError("CPU preflight receipts may not enter formal result roots")
    if output.exists():
        raise FileExistsError(f"refusing to overwrite preflight receipt: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = run_preflight(args.manifest)
        if args.output is not None:
            write_receipt(args.output, payload)
    except (ContractError, FileExistsError, ImportError, OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "schema_name": "lifeline-d19-v2-matched-history-cpu-preflight",
                    "schema_version": 1,
                    "status": "FAIL_CLOSED",
                    "error": f"{type(exc).__name__}: {exc}",
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
