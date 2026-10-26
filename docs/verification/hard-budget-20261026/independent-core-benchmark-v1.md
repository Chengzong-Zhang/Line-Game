# Independent budgeted Hard core benchmark v1

Status: `PASS_BOUNDED_CORE_DEVELOPMENT_PROBES_NO_PRODUCT_ADMISSION`.

This record covers the frozen `BudgetedMinimaxAI.js` core SHA256
`6083b9a3516c16fb835bf33f1c4cfb31f668444f57491f00a3bd7a3ee0305ccf`.
The matching compact machine-readable evidence is
[`independent-core-benchmark-v1.json`](independent-core-benchmark-v1.json).
It describes the measured core call before integration; it makes no assertion
about later Worker or product-route changes in the same worktree.

## Protocol and input provenance

The independent reviewer ran each of five selected development states once:
`timeMs=3000`, `reserveMs=200`, `maxDepth=8`, `topN=5`, with a shared explicit
start time and total deadline. The elapsed column includes core preparation and
search. No PASS guard, action application, Worker communication, rendering or
phone execution was included. The clock-recovery fixtures below are functional
checks with fake clocks and are separate from the five actual timing calls.

Four states were reconstructed by verified native replay of the frozen H16
arena: the three slowest distinct recorded Hard pre-action states and the
median recorded n7 Hard action. The fifth is the existing n5 native-terminal
winning witness from `verify-minimax-deepening.mjs`, reconstructed by its four
legal prefix actions. Inputs are post-evaluation development cases, excluded
from old H16 training, and forbidden as training data. Old Hard was not rerun;
its elapsed values and selected actions are references from the frozen arena.
The exclusion is a no-feedback/use restriction, not a verified claim of zero
state overlap with old training data or an independent held-out strength set.

Raw states, histories, the runner and individual receipts remain under local
`local_artifacts/hard-budget-20261026/`. The compact JSON binds their hashes.
The source arena manifest SHA256 is
`f5d203e0684dbbacf4997a4c2b740e704a9a6d2c71e04942fed2ff26eae28fc1`.
All 17 manifest-bound sources in the separate Ultimate worktree were still
byte-identical when this report was finalized. The known H16 and H64 arena
progress receipts both showed `COMPLETE`, 16/16, before and after measurement.
This bounds known arena contention; it does not prove the host was idle.

## Results

| Development case | Old recorded applied ms | New core ms | Completed iteration depth | Max actual Minimax plies reached | Selected point | Partial iteration discarded | Quality tradeoff below depth 4 |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| n9 slowest 1 | 50402.1188 | 2800.6309 | 2 | 3 | `[6,1]` | yes | yes |
| n9 slowest 2 | 36703.5481 | 2800.1951 | 2 | 3 | `[4,0]` | yes | yes |
| n9 slowest 3 | 31463.7917 | 2800.2712 | 2 | 3 | `[1,0]` | yes | yes |
| n7 median reference | 520.4319 | 2127.1281 | 6 | 5 | `[0,2]` | no | no |
| n5 native winning witness | n/a | 693.9908 | 8 | 8 | `[2,0]` | no | no |

The first three calls completed only depths 1 and 2; each began depth 3 and
discarded that unfinished iteration. Their selected points match the recorded
old choices, which does not establish equal search quality or strength. The n7
call stopped after a depth-6 iteration marked terminal-solved within the
preserved candidate tree; its maximum actual Minimax traversal was five plies.
Iteration depth and actual traversed plies are therefore reported separately.
The n5 witness selected the existing native oracle's unique winning point
`[2,0]` (terminal value `+1`); it did not mark the complete candidate tree solved.

All five calls preserved every own source-engine property descriptor/value and
its prototype, including rule/history state, caches and methods. Selected
actions passed the canonical engine legality check on a separate engine.
No measured source engine received an action. The three timed-out calls
returned with approximately 199.37, 199.80 and 199.73 ms left in the total budget.
The cooperative search deadline overran by 0.488 ms at most; no call exceeded
the declared total deadline. The unused reserve does not prove an actual PASS
guard will finish within it.

Four additional fixtures passed source preservation and restoration of the
configured depth and temporary deadline: non-finite first clock value,
non-finite mid-search value, backward clock, and expiry before any iteration.
The first three reject the invalid clock; the expired case returns an explicitly
unsearched depth-0 legal-placement fallback. These are recovery checks, not
timing or strength measurements.

## Review findings and claim boundaries

Before the frozen benchmark, review found that `turnCount` could not measure
actual search plies because explicit PASS does not increment it. The author
changed the diagnostic to the `positionRevision` delta. Inspection confirmed
explicit placement/PASS each increment the revision once, while automatic
skips do not. The reported plies include PASS actions.

The core preserves the prior 20-placement-plus-PASS candidate tree, root
ordering/pruning, native terminal evaluation, heuristic scoring, risk penalties
and four-action tactical overlays. It is not a full-legal-root teacher and these
calls produce no training labels. Terminal-solved flags refer only to that
preserved candidate tree.

This selected five-state, one-shot development probe establishes legal bounded
core behavior and state preservation on these inputs. It does not establish
equivalent speedup, equivalent depth-4 strength, a worst-case hard deadline,
full-match strength, product admission, or a complete three-second decision
path. Old timings include selection/application while new timings cover the
core; their ratio is not an equivalent-work speedup. In particular, depth 2 on
the slow n9 cases is an explicit quality tradeoff. Integrated PASS-guard time,
Worker request freshness, browser/Mini Game operation and phone acceptance
require separate receipts bound to their integrated source versions.

## Reproduction and preservation

The original one-shot command was
`node local_artifacts/hard-budget-20261026/benchmark-independent.mjs` from the
pass-discipline worktree. Its output directory is created exclusively; preserve
the existing run. A new benchmark must use a new versioned output directory and
report any changed source or input hashes.

The local full receipt SHA256 is
`64e7c52613ce153d2356541d1565b63a5e89368369d488e6fd3c174351a04068`;
the local input SHA256 is
`b9bda560110df223c96e28c881c263746bf7c4306fa0fb31eb1a25525eeaa10b`.
The read-only compact-evidence check is
`node docs/verification/hard-budget-20261026/verify-independent-core-benchmark-v1.mjs`.
It verifies the preserved local receipt/input/runner bindings, current bound
core sources, compact rows and the frozen Ultimate manifest sources without
replaying games or rerunning Minimax.
