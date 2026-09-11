from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import d18_v3_verify_evidence as verifier  # noqa: E402


def _configure_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    research = tmp_path / "research" / "iclr2027"
    source_root = research / "results" / "formal" / "d14_d16" / "run_v1" / "tasks"
    validation = research / "results" / "validation"
    evidence_path = validation / "evidence.json"

    artifact_paths = {
        "formal_manifest": "configs/d14_d16_formal_manifest.json",
        "formal_result_receipts": (
            "results/formal/d14_d16/run_v1/result_receipts.jsonl"
        ),
        "task_bundle_manifest_snapshot": (
            "results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json"
        ),
        "task_bundle_summary": (
            "results/formal/d14_d16/task_bundle_v1/bundle_summary.json"
        ),
    }
    artifacts = {
        name: {
            "relative_path": relative_path,
            "sha256": hashlib.sha256(name.encode("utf-8")).hexdigest(),
            "size_bytes": len(name),
        }
        for name, relative_path in artifact_paths.items()
    }

    games = {
        "a/games.jsonl": [(5, 2), (7, 3)],
        "b/self_play_games.jsonl": [(9, 4), (9, 5)],
    }
    source_manifest: list[dict[str, object]] = []
    histograms = {5: {}, 7: {}, 9: {}}
    for relative, values in games.items():
        payload_rows = []
        for size, plies in values:
            payload_rows.append(
                json.dumps(
                    {
                        "grid_size": size,
                        "plies": plies,
                        "truncated": False,
                        "actions": [{} for _ in range(plies)],
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
            histograms[size][plies] = histograms[size].get(plies, 0) + 1
        payload = ("\n".join(payload_rows) + "\n").encode("utf-8")
        source_manifest.append(
            {
                "path": (
                    "results/formal/d14_d16/run_v1/tasks/" + relative
                ),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload),
            }
        )
    source_manifest.sort(key=lambda row: str(row["path"]))
    source_manifest_sha = hashlib.sha256(
        json.dumps(
            source_manifest,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    size_rows = {}
    for size, histogram in histograms.items():
        p999 = max(histogram)
        size_rows[str(size)] = {
            "game_count": sum(histogram.values()),
            "histogram": {str(key): value for key, value in sorted(histogram.items())},
            "historical_max_plies": max(histogram),
            "nearest_rank_p999_plies": p999,
            "empirical_planning_plies": p999 * 2,
        }
    evidence = {
        "interpretation": {
            "execution_max_plies_unchanged": True,
            "fail_closed_if_future_execution_truncates": True,
            "scope": (
                "capacity planning only; this receipt does not alter the formal "
                "execution protocol or certify a future run"
            ),
        },
        "max_plies": 256,
        "planning_multiplier": 2,
        "provenance": {"artifacts": artifacts, "puct_simulations": 16},
        "quantile": {
            "method": "nearest_rank",
            "probability_denominator": 1000,
            "probability_numerator": 999,
        },
        "schema_name": verifier.EMPIRICAL_CAPACITY_EVIDENCE_SCHEMA,
        "schema_version": 1,
        "sizes": size_rows,
        "source_manifest": source_manifest,
        "source_manifest_canonicalization": (
            "UTF-8 JSON, sorted keys, compact separators; entries sorted by path"
        ),
        "source_manifest_sha256": source_manifest_sha,
        "source_root": "results/formal/d14_d16/run_v1/tasks",
        "status": "PASS",
        "total_games": 4,
        "total_source_files": 2,
        "total_truncated_games": 0,
    }

    monkeypatch.setattr(verifier, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(verifier, "RESEARCH_ROOT", research)
    monkeypatch.setattr(
        verifier,
        "EMPIRICAL_CAPACITY_EVIDENCE_RELATIVE_PATH",
        "research/iclr2027/results/validation/evidence.json",
    )
    monkeypatch.setattr(verifier, "EMPIRICAL_CAPACITY_SOURCE_FILES", 2)
    monkeypatch.setattr(verifier, "EMPIRICAL_CAPACITY_TOTAL_GAMES", 4)
    monkeypatch.setattr(
        verifier,
        "EMPIRICAL_CAPACITY_EXPECTED_PLANNING_PLIES",
        {5: 4, 7: 6, 9: 10},
    )
    monkeypatch.setattr(
        verifier, "EMPIRICAL_CAPACITY_SOURCE_MANIFEST_SHA256", source_manifest_sha
    )

    def write_evidence() -> dict[str, object]:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        payload = (
            json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")
        evidence_path.write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        monkeypatch.setattr(verifier, "EMPIRICAL_CAPACITY_EVIDENCE_SHA256", digest)
        return {
            "relative_path": verifier.EMPIRICAL_CAPACITY_EVIDENCE_RELATIVE_PATH,
            "sha256": digest,
            "source_manifest_sha256": source_manifest_sha,
            "schema_name": verifier.EMPIRICAL_CAPACITY_EVIDENCE_SCHEMA,
            "schema_version": verifier.EMPIRICAL_CAPACITY_EVIDENCE_SCHEMA_VERSION,
        }

    return evidence, write_evidence, source_root


def test_empirical_capacity_evidence_is_independently_recomputed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _evidence, write_evidence, _source_root = _configure_fixture(tmp_path, monkeypatch)
    assert not _source_root.exists()
    assert not (
        tmp_path / "research" / "iclr2027" / "configs" / "d14_d16_formal_manifest.json"
    ).exists()
    binding = write_evidence()
    assert verifier._validate_empirical_capacity_evidence(binding) == {
        5: 4,
        7: 6,
        9: 10,
    }


@pytest.mark.parametrize(
    "mutation", ["histogram", "source_manifest", "provenance", "binding"]
)
def test_empirical_capacity_tamper_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    evidence, write_evidence, _source_root = _configure_fixture(tmp_path, monkeypatch)
    if mutation == "histogram":
        evidence["sizes"]["9"]["histogram"]["5"] += 1
    elif mutation == "source_manifest":
        evidence["source_manifest"][0]["bytes"] += 1
    elif mutation == "provenance":
        evidence["provenance"]["artifacts"]["formal_manifest"][
            "relative_path"
        ] = "../formal_manifest.json"
    binding = write_evidence()
    if mutation == "binding":
        binding["source_manifest_sha256"] = "0" * 64
    with pytest.raises(verifier.VerificationError):
        verifier._validate_empirical_capacity_evidence(binding)


def test_nearest_rank_999_over_1000_uses_ceiling_rank() -> None:
    histogram = {1: 998, 2: 1, 9: 1}
    assert verifier._nearest_rank_from_histogram(
        histogram, numerator=999, denominator=1000
    ) == 2
