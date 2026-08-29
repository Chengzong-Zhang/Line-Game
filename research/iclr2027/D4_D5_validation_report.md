# D4-D5 environment validation report

Date: 2026-08-25

Scope: dependency-free, two-player `LifelineGame`/`LifelineEnv`, side lengths 5-15

## Outcome

The D4-D5 validation gate passes for the stated two-player reference-environment
scope.  The Python transition engine matched the Web rule source on the enlarged
differential suite, the targeted attack/cascade regressions pass with exact
post-state assertions, and all observed state/edge invariants remain stable
under deterministic seeded play.

No natural Superko witness exists on side length five under the current rules:
this is an exhaustive finite-graph result, not a failed random search.  It does
not establish absence on larger boards. A later PASS-aware D6 search found a
standard-start natural witness on side length six; the post-D6 addendum below
records it without weakening the exact side-five result.

## 1. Unit and deterministic property tests

Command:

```powershell
Push-Location .\research\iclr2027
python -B -m unittest discover -s . -t . -v
Pop-Location
```

Frozen-core reproduction command (run from `research/iclr2027`):

```powershell
python -B -m unittest `
  tests.test_agents tests.test_arena tests.test_core tests.test_d6_aliasing `
  tests.test_env tests.test_search_baselines tests.test_serialization `
  tests.test_superko_ablation tests.test_validation -v
```

The frozen D1--D8 core suite is `62/62`. In a live expanded-tree rerun at
`2026-08-25 23:48:20 +08:00`, the exact command above returned exit code `0`
and `Ran 88 tests ... OK (skipped=7)`: 81 tests passed and seven optional
PyTorch-dependent tests were skipped because `torch` was unavailable. Skips
are not failures and are kept separate from the frozen core count. Five tests
in `tests/test_validation.py` are specific to the original gate; the later
nine D6 dataset/definition-regression tests and six natural Superko/ablation
tests are included in the 62-test frozen total. The frozen-core command was
rerun at `2026-08-25 23:49:52 +08:00` and returned `Ran 62 tests ... OK`.

The added checks cover:

- exact cascade deletion after the reachable prefix `HISTORY_A[:6]` and attack
  at `(2,2)`: `(3,1)`, `(1,3)`, and `(0,4)` are deleted, while the surviving
  WHITE edge `(2,0)--(4,0)` and its intermediate line point `(3,0)` are restored;
- exact line-cut behavior after `HISTORY_A[:9]` and attack at `(1,1)`: only the
  BLACK edge `(0,1)--(2,1)` is cut, no BLACK node is deleted, all other BLACK
  edges survive, and the automatic no-move skip returns the turn to WHITE;
- full transactional rollback on a synthetically reachable repeated Superko
  key, including board, logical edges, player, counters, history, serialization,
  and the legal-move result;
- replay of a standard-start 6×6 natural Superko rejection, exact rollback in
  `enforce` mode, acceptance and repeat-loop closure in `observe` mode, and
  mode-preserving snapshot/serialization behavior;
- seeded deterministic replays on side lengths 5, 7, 9, 12, and 15;
- purity of `evaluate_move` and repeated `legal_moves` queries;
- structural invariants after every checked transition: every edge has friendly
  node endpoints and a friendly physical path, every line point belongs to an
  explicit edge, and every node remains edge-connected to its player's source.

The original synthetic Superko test remains explicitly labelled synthetic; its
purpose is to isolate rejection and rollback. It is now complemented, not
replaced, by the independently frozen natural 6×6 replay fixture.

## 2. Python/Web differential validation

Command:

```powershell
python .\research\iclr2027\scripts\check_reference_parity.py `
  --random-games 60 --max-plies 120 --seed 20260825
```

Observed result: exit code `0`; `65` complete traces matched.  The matrix contains
five deterministic fixtures plus 60 seeded random traces, distributed evenly
over side lengths 5, 7, 9, 10, 12, and 15.

Two deterministic fixtures were added specifically for the cascade-delete/edge-
restore and line-cut/no-node-delete transitions above.  Every compared step
checks move success/reason, physical board, player to act, game-over flag, PASS
counter, turn count, both logical-edge sets, and the complete legal-move list.
At terminal states it additionally checks exact territory areas and winner.

This is broad differential evidence, not an exhaustive Python/Web equivalence
proof at any board size. The separate side-five raw-graph result below is an
exhaustive analysis of the Python rules state space, not of cross-implementation
equivalence.

## 3. Natural Superko: exact side-five result

Reproduction command:

```powershell
python .\research\iclr2027\scripts\validate_or_search_superko.py `
  --mode exhaustive --grid-size 5 `
  --output .\research\iclr2027\results\validation\superko_n5_exhaustive_20260825.json
```

Observed result: exit code `0`.

| Quantity | Exact value |
| --- | ---: |
| Reachable raw states | 25,096 |
| Raw transitions | 67,505 |
| Distinct move history keys | 14,855 |
| Nodes covered by topological order | 25,096 |
| Maximum raw path length | 40 |
| Maximum per-node reachable-history-key union | 1,605 |
| Repeated key on a path | none |

Method:

1. Enumerate every locally valid move from the standard side-five start with
   history temporarily normalized away.  A node retains the complete board,
   both logical-edge sets, player, terminal flag, and consecutive-PASS count.
   The raw transition helper also keeps history empty during the automatic
   no-move check, so the construction does not assume the conclusion it tests.
2. Include every non-terminal voluntary single-PASS transition.  The second
   consecutive PASS is omitted because it terminates immediately and writes no
   Superko history key, so it cannot enable a later move.
3. Record on every move edge the exact state key that real play would add.
4. Verify by Kahn topological sort that all 25,096 nodes form a DAG.
5. In topological order, propagate state-key membership with exact integer
   bitsets.  For each move edge, test whether its key occurred on any path that
   reaches the source node.  No edge repeats such a key.

The union DP is exact for this query: each individual set bit means that at
least one path carrying that key reaches the node, and a candidate repetition
depends on one key, not on a conjunction of keys.  Since no raw path repeats a
key, Superko never removes a move in real side-five play and therefore cannot
create an additional history-induced automatic skip.

Proof boundary: this conclusion applies only to the current two-player rules,
standard start, side length five, current logical-edge semantics, and current
state-key definition.  It must not be generalized to side lengths 6-15,
three-player play, a different start state, or modified rules.  Consequently no
natural Superko fixture was fabricated for D5. The later positive 6×6 witness
is consistent with, and outside the scope of, this side-five certificate.

The graph builder is intentionally importable.  `build_raw_graph(5,
include_passes=True)` exposes immutable snapshots and action-labelled successor
edges for downstream exact dynamic programming.

### 3.1 Post-D6 natural side-six witness and rule ablation

A PASS-aware attack-biased search from the standard 6×6 initial state found the
following natural prefix and rejected candidate:

```text
B(0,1), W(4,0), B(2,0), W(1,4), B(2,3),
W(2,2), B(3,1), W(1,4), B PASS, W(1,1),
B(2,3) -> SUPERKO_VIOLATION
```

With Superko observed but not enforced, the last six transitions return to the
same rule-relevant position and can repeat. The frozen fixture is
`state_aliasing/superko_n6_witness_v1.json`; its source search artifact is
`results/validation/superko_random_n6_seed20260826.json` (SHA-256
`EFB6BF27D35E8894D9F8C749C8C86765CBCF957060B55AA8456C006051A84CA0`).
Python and the independent Web rules agree on the prefix and rejection.

This proves that Superko can bind in natural 6×6 play. It does not provide two
natural histories with identical mask-free Topology and different legality, so
it is not the missing strict paired-state alias.

The canonical schema-v2 ablation uses set-size-independent keyed action
priorities and 2,000 paired attack+PASS episodes at each of n=6 and n=7. At
n=6 it observed 0/2,000 trigger episodes, trajectory divergences, and
truncations; the zero-trigger Wilson 95% upper bound is 0.1917%, and both modes
had B/W/D counts 1,020/948/32. At n=7 it observed 2/2,000 trigger episodes
(Wilson 95% CI 0.0274%--0.3639%); `observe` selected a repetition in one episode
(two repeated actions), producing one trajectory divergence. Nevertheless all
2,000 paired winners agreed, both modes had B/W/D 1,043/934/23, and neither
mode truncated. Mean plies were 24.5780 versus 24.5755, a -0.01017% relative
difference with paired-bootstrap 95% CI [-0.03076%, 0]. Nonzero Black-score
differences were 0/2,000 at both sizes, with a Wilson upper bound of 0.1917%.

The internal fixed practical-similarity gates pass for this policy, sizes, and
120-ply horizon. This remains engineering validation: the coupling method was
revised after inspecting exploratory output, the base seed was reused, and only
one handcrafted policy was tested. The result supports "empirically similar
under the sampled policy," never rule equivalence or safe removal of Superko.
Full protocol and interpretation are in `SUPERKO_ABLATION_PROTOCOL.md` and
`SUPERKO_ABLATION_RESULTS.md`. The canonical artifact SHA-256 is
`4F31ECB8F53ADD3151CE0B879CB3C9AD296F21C5D4B6B9553A9E6DD21221EE09`; the
runner SHA-256 is
`38FD1D436F7AB9C416BD540C09969BC99646BC16A051D292D855E02916AC162F`.

## 4. Repeated end-to-end throughput

Command:

```powershell
python .\research\iclr2027\scripts\validate_or_search_throughput.py `
  --sizes 5 7 9 10 12 15 --transitions 200 `
  --warmup-transitions 20 --repeats 3 --seed 20260825 `
  --output .\research\iclr2027\results\validation\throughput_20260825.json
```

Observed result: exit code `0`.  Each size uses an identical seeded workload in
all three timed repetitions after a 20-transition warm-up.  The timed scope
includes reset, legal-action-mask construction, environment step, observation
construction, and terminal scoring.

Machine: Windows 11 `10.0.26200`, Python `3.12.11`, AMD64 Family 25 Model 117.

| Side | Runs (transitions/s) | Median | Min-max |
| ---: | --- | ---: | ---: |
| 5 | 1615.26, 1573.92, 1501.41 | 1573.92 | 1501.41-1615.26 |
| 7 | 605.87, 617.47, 681.97 | 617.47 | 605.87-681.97 |
| 9 | 278.88, 273.32, 226.40 | 273.32 | 226.40-278.88 |
| 10 | 129.57, 125.04, 124.89 | 125.04 | 124.89-129.57 |
| 12 | 64.79, 59.94, 66.23 | 64.79 | 59.94-66.23 |
| 15 | 19.26, 18.95, 20.04 | 19.26 | 18.95-20.04 |

These are local engineering measurements, not paper-level performance claims.
Side length 15 remains too slow for high-budget Python MCTS without profiling,
incremental legality updates, or make/unmake transitions.

## 5. Artifacts and remaining limits

Added for D4-D5:

- `tests/test_validation.py`
- `scripts/validate_or_search_superko.py`
- `scripts/validate_or_search_throughput.py`
- `results/validation/superko_n5_exhaustive_20260825.json`
- `results/validation/throughput_20260825.json`
- this report

Post-D6 addendum artifacts:

- `state_aliasing/superko_n6_witness_v1.json`
- `tests/test_superko_ablation.py`
- `scripts/run_superko_ablation.py`
- `results/validation/superko_ablation_smoke_20260825.json`
- `results/validation/superko_ablation_n6_n7_canonical_pilot_20260825.json`
- `SUPERKO_ABLATION_PROTOCOL.md`
- `SUPERKO_ABLATION_RESULTS.md`

Modified for D4-D5:

- `scripts/check_reference_parity.py` (two deterministic attack fixtures)

The transition core was not modified during the original D4-D5 gate. The later
ablation work added explicit `enforce` and `observe` modes while preserving
the default behavior. Remaining validation limits are:

- no exhaustive Python/Web equivalence proof;
- no Superko absence proof for sizes 6-15; n=6 has a frozen natural witness,
  n=7 has sampled natural triggers in the canonical pilot, and sizes 8-15
  remain open;
- no strict double-natural-history Superko alias, and no adequately powered
  multi-seed or trained-agent rule-ablation result; the canonical one-policy
  pilot is not a rule-equivalence study;
- no profiler-backed optimization of large-board throughput;
- no three-player validation, which is outside the frozen paper scope.
