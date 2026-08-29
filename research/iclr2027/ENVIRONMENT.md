# LIFELINE-RL environment v0.1

This is the dependency-free two-player training and reference environment for
the ICLR 2027 sprint. The product-facing rule source is
`web/web前端/GameEngine.js`; this implementation is an independent Python port
with differential validation against that engine.

## Scope

- triangular boards with side length 5 through 15;
- two players, deterministic alternating turns;
- explicit player-specific logical edges;
- protection zones, three-point restriction, attacks, cascading deletion, edge
  cleanup and restoration, and Superko;
- a final PASS action and two-consecutive-PASS termination;
- exact territory calculation at terminal states only;
- terminal rewards of win `+1`, loss `-1`, and draw `0`.

Three-player play, resignation, UI behavior, and shaped rewards are deliberately
not part of this training environment.

## Install or run from the repository

The core requires only Python 3.10 or newer. An editable installation is:

```powershell
python -m pip install -e .\research\iclr2027 --no-deps
```

Without installing it, run from the repository root with:

```powershell
$env:PYTHONPATH="$PWD\research\iclr2027"
python -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -v
```

Minimal use:

```python
from lifeline_rl import LifelineEnv

env = LifelineEnv(grid_size=5, observation_mode="topology")
observation, info = env.reset(seed=0)

mask = observation["legal_action_mask"]
action = next(index for index, legal in enumerate(mask) if legal)
observation, reward, terminated, truncated, info = env.step(action)
```

## Action contract

For a side length `n`, the first `n(n+1)/2` actions correspond to points in the
fixed order

```text
(0,0), (1,0), ..., (n-1,0), (0,1), ..., (0,n-1)
```

with invalid square-matrix coordinates omitted. The last action is PASS.
`point_to_action`, `action_to_point`, and `legal_action_mask` are the canonical
conversion functions.

Illegal actions raise `ValueError` by default. The optional `penalty` mode
returns `-1` without changing the state; it exists for robustness experiments
and is not the main self-play protocol.

## Step and reward contract

`step` returns the Gymnasium-shaped tuple

```text
observation, reward, terminated, truncated, info
```

The scalar reward is from the perspective of the player who submitted that
action. It is zero before termination. At termination, `info["rewards"]`
contains both zero-sum player payoffs, which removes any ambiguity for an
alternating-player replay buffer. `truncated` is always false in v0.1.

## Observation protocols

| Mode | Board and coordinates | Physical lattice edges | Logical edges | Exact history digests |
| --- | --- | --- | --- | --- |
| `grid` | yes | no | no | no |
| `grid_graph` | yes | yes | no | no |
| `topology` | yes | yes | yes | no |
| `topology_history` | yes | yes | yes | stable SHA-256 identifiers |

All modes include the player to act, consecutive-PASS count, and legal-action
mask. `topology_history` is variable-length and identifies every retained
position with a stable SHA-256 digest. The simulator retains the unhashed exact
state keys; a fixed-size learned history encoder remains a model-level ablation
rather than a simulator shortcut.

The simulator itself always retains the exact board, both logical-edge sets,
Superko history, player, PASS counter, and terminal flag. `clone` and `restore`
preserve every one of these fields.

## Verification evidence on 2026-08-25

The following local checks passed:

- 55 standard-library tests covering rules, serialization, environment API,
  deterministic properties, search agents, arena artifacts, and replay;
- 65 Python/Web differential traces: 5 deterministic fixtures plus 60 seeded
  random traces over board sizes 5, 7, 9, 10, 12, and 15, up to 120 plies;
- every checked step matched on the physical board, player, PASS counter,
  logical edges, legal moves, terminal state, terminal territory, and winner.

Reproduce the differential check with:

```powershell
python .\research\iclr2027\scripts\check_reference_parity.py --random-games 60 --max-plies 120
```

The harness suppresses the Web engine's intermediate territory-cache refresh
and computes it at terminal, matching the training engine. Territory never
feeds back into move legality or state transitions.

A repeated local benchmark used 200 transitions per repetition, a 20-transition
warm-up, and three identical-seed repetitions per size:

| Side length | Median transitions/second | Observed min-max |
| ---: | ---: | ---: |
| 5 | 1573.92 | 1501.41-1615.26 |
| 7 | 617.47 | 605.87-681.97 |
| 9 | 273.32 | 226.40-278.88 |
| 10 | 125.04 | 124.89-129.57 |
| 12 | 64.79 | 59.94-66.23 |
| 15 | 19.26 | 18.95-20.04 |

These are engineering measurements, not paper-level performance claims. The
timed workload includes full legal-action-mask construction, reset and
observation work, and exact scoring at episode termination. Size 15 is a clear
optimization target.

## Known limitations and next gates

- The interface follows Gymnasium's reset/step shape but does not yet inherit
  from `gymnasium.Env` or define third-party `Space` objects.
- The verified paired-state fixture proves equal physical boards can hide
  different logical edges. It still does not prove a reward, legality, visible
  transition, or optimal-policy difference.
- The complete side-five raw graph proves that natural Superko cannot trigger
  at that size. Sizes 6-15 still have neither a natural witness nor an absence
  proof; the synthetic rollback test is labelled as branch coverage only.
- Vectorized execution, profiling, and search-specific make/unmake transitions
  are still needed for large MCTS workloads.
