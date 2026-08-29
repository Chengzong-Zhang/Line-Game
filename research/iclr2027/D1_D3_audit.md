# D1-D3 delivery audit

Audit date: 2026-08-25

This audit maps the first three sprint milestones to concrete, locally
verifiable artifacts. It distinguishes completed engineering deliverables from
later scientific claims.

## D1: frozen paper contract

Status: **complete**.

| Required item | Evidence |
| --- | --- |
| Working title | `D1_research_contract.md`, Section 1 |
| Primary and secondary research questions | `D1_research_contract.md`, Section 3 |
| Four bounded contributions | `D1_research_contract.md`, Section 4 |
| Machine-readable experiment matrix | `experiment_matrix.csv` |
| Paper directory and section outline | `paper/main.tex`, `paper/references.bib` |

The contract explicitly forbids promoting an environment release, weak
state-aliasing witness, or small smoke result into an unsupported learning or
generalization claim.

## D2-D3: training environment

Status: **complete for the dependency-free reference interface**.

| Required item | Evidence |
| --- | --- |
| UI-free rule core | `lifeline_rl/core.py` |
| Fixed point/action order and final PASS action | `LifelineEnv.action_to_point`, `point_to_action` |
| Legal-action mask | `LifelineEnv.legal_action_mask` |
| Terminal `+1/0/-1` reward | `LifelineEnv.step`, `LifelineGame.rewards` |
| Full state copy/restore | `GameSnapshot`, `clone`, `restore` |
| Versioned serialization | `serialize_state`, schema version 1 |
| Canonical representation | `canonical_state_json`, `state_fingerprint` |
| Strict reconstruction | `restore_serialized`, `from_serialized_state` |
| Replay | core point replay and environment action replay |
| Observation ablations | Grid, GridGraph, Topology, TopologyHistory |

Serialization restoration validates board length and values, canonical point
order, current logical edges, Superko history entries, player, terminal flag,
skip count, and turn count. Terminal territory is recomputed rather than trusted
from unvalidated serialized derived fields.

## Acceptance commands

From the repository root:

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"
python -m unittest tests.test_core tests.test_env tests.test_serialization -v
python .\research\iclr2027\scripts\check_reference_parity.py --random-games 18 --max-plies 80
```

The Gymnasium-shaped wrapper intentionally has no mandatory third-party
dependency yet. Native `gymnasium.Space` objects and vectorized execution are
later integration/performance tasks, not missing reference-rule semantics.
