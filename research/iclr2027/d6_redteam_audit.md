# D6 Red-Team Audit: State Aliasing Claims

Date: 2026-08-25

This audit is intentionally narrower than the D6 search report. It asks which
scientific claims are supported by complete evidence, independently recomputes
the side-five solution, and records definition mismatches that could otherwise
turn a bounded search result into an overclaim.

## Verdict

1. The existing reachable side-five pair is a valid **weak topology-aliasing
   witness**. Its two histories produce exactly equal current `grid`
   observations under the implemented encoder and different logical-edge
   observations. It does not show a difference in legality, observable
   transition, return, Q value, or optimal action.
2. Complete side-five enumeration supports a genuine negative result: under
   the current two-player rules and standard initial state, neither requested
   strict class exists at side length five.
3. This result does **not** prove nonexistence at side lengths 6--15. A finite
   random or targeted search at those sizes must be reported as
   `NOT_FOUND_WITHIN_BUDGET`, never as nonexistence.
4. The earlier exact value implementation omitted a legal class of terminal
   PASS actions. Its side-five no-witness conclusion happens to agree with the
   corrected independent solver, but the earlier value table is not itself a
   valid exact certificate.

The requested D6 deliverable "two strict counterexamples" therefore cannot be
marked complete using current evidence. The honest deliverable is one weak
paired-state fixture, an exhaustive side-five negative result, and bounded
larger-board search reports unless a larger-board strict witness is found.

## Definitions audit

### Topology class

A scientifically useful strict pair should satisfy equality under the exact
reduced observation map being evaluated, while differing in at least one of:

- legal actions;
- reward or termination for a shared action;
- next reduced observation for a shared action;
- exact value or Q target under a fixed solution concept;
- optimal policy requirements.

The search definition is broadly reasonable, but two qualifications are
necessary.

First, the implemented `grid` encoder already includes `legal_action_mask`.
Consequently, a pair whose legal sets differ is not aliased by the actual
implemented `grid` observation. Such a pair is a witness only for a separately
defined board-only map that excludes the mask. The paper and dataset must name
the map explicitly. The current weak fixture is not affected: its complete
implemented `grid` observations and legal masks are equal.

The paper's current Grid-equivalence sentence mentions only occupancy and
player, while the implemented encoder also exposes `consecutive_skips` and the
mask (whose PASS entry exposes termination). The search correctly requires
equal skip and terminal status, but the paper definition should be rewritten to
match either the implemented encoder exactly or a deliberately mask-free
board-only ablation.

Second, unequal optimal-action sets are a target difference, but do not by
themselves prove that a shared observation policy must fail: the two sets may
overlap. A stronger policy-insufficiency claim should require disjoint optimal
sets, or report the minimum unavoidable regret of a single shared action. This
audit reports both unequal and disjoint sets.

### History/Superko class

The strict history definition is crisp: equal current board, logical edges,
player, skip state, and terminal state; different retained Superko histories;
and a concrete action that is legal in exactly one state because it is rejected
as `SUPERKO_VIOLATION` in the other. Omitting `turn_count` from this equality is
sound for the current engine because it affects neither rules nor observations.

Different history sets alone are weak full-state aliasing, not decision
relevance. A synthetically injected prior key is useful for branch coverage but
must not be presented as a naturally reachable paired-state witness.

## Why the side-five Superko negative result is exhaustive

`validate_or_search_superko.py` constructs the complete raw transition graph
from the standard side-five initial state after removing path history from the
node identity. The identity retains every path-independent rule variable:
board, both typed logical-edge sets, current player, terminal flag, and
consecutive skips. `turn_count` is safely merged because it does not affect a
transition. Every locally successful placement is represented; every
nonterminal PASS is represented. A terminal PASS adds no Superko key and has no
future, so omitting it from the raw graph is sound for the Superko question.

The graph contains 25,096 unique root-reachable nodes and 67,505 transitions,
and all nodes are covered by a 25,096-node topological order. For every raw
node, bitset propagation unions all history keys that occur on any incoming
path. It does not preserve correlations between multiple keys, but this query
asks about only one edge key at a time. Each set bit therefore means that at
least one real path carrying that key reaches the node, and that path can take
the path-independent outgoing edge. Membership is exact for this single-key
repetition query. No move edge repeats such a key, so no natural Superko
rejection occurs on any side-five trajectory under this rule implementation.

This also rules out a strict history/Superko pair at side length five: the
required history-dependent rejection never occurs in any reachable side-five
state.

## Independent exact decision-relevance check

The independent script `scripts/d6_redteam_exact_audit.py` does not call the D6
searcher's exact solver. It reuses the enumerated raw graph, checks unique node
keys, edge ranges, unique outgoing actions, and root reachability, then performs
zero-sum backward induction. Crucially, it executes PASS from **every**
nonterminal state and scores terminal PASS successors directly.

Results:

| Quantity | Result |
| --- | ---: |
| Raw states | 25,096 |
| Raw transitions | 67,505 |
| Grid alias groups | 976 |
| Same-Grid, different-topology pairs | 1,088 |
| Pairs with different legal actions | 0 |
| Pairs with different next implemented-Grid observation | 0 |
| Pairs with different exact black value | 0 |
| Pairs with different shared-action Q values | 0 |
| Pairs with unequal optimal-action sets | 0 |
| Pairs with disjoint optimal-action sets | 0 |

The next-observation comparison includes the successor legal-action set, so it
matches the implemented Grid encoder's action-mask information rather than the
narrower board-only successor used by the first classifier.

The corrected side-five initial value is a black win (`+1`) under the current
deterministic zero-sum solution concept. This is an implementation-level exact
result, not an empirical baseline score.

## PASS omission found in the earlier exact solver

The earlier `exact_grid_value_search` adds a terminal PASS only when
`consecutive_skips == 1`. There are also 2,080 raw states with
`consecutive_skips == 0` where PASS switches player and the automatic no-move
rule immediately performs the second skip and terminates. Those legal terminal
actions are absent from the raw adjacency because terminal PASS states are
correctly omitted for the Superko graph, but a value solver must add them back.

Compared with the corrected all-PASS solver, this omission changes:

- 294 state values;
- 1,272 optimal-action sets.

The initial value remains `+1`, and both solvers happen to report zero strict
topology pairs. The corrected solver is the required certificate; agreement of
the final pair count does not make the omitted branches harmless in general.

## Reproduction

Run from the repository root:

```powershell
python .\research\iclr2027\scripts\validate_or_search_superko.py --mode exhaustive --grid-size 5
```

```powershell
python .\research\iclr2027\scripts\d6_redteam_exact_audit.py --output .\research\iclr2027\d6_redteam_exact_audit.json
```

The JSON report is the machine-readable evidence for the counts above.

## Claim language safe for the paper

Safe:

> We found reachable side-five states with identical implemented Grid
> observations and different latent logical-edge sets. Complete side-five
> enumeration found no pair in which this latent difference changed legality,
> observable one-step transitions, exact values, Q values, or optimal actions.
> The same enumeration found no naturally triggerable Superko rejection.

Unsafe without new evidence:

- "Grid observations are non-Markov" for the current game family;
- "logical edges are decision necessary";
- "Superko produces reachable state aliasing";
- "strict counterexamples do not exist" at side lengths 6--15;
- any conversion of a bounded larger-board search failure into an impossibility
  claim.

The current evidence supports topology as a potentially useful inductive bias
and a state-diagnostics question. It does not yet support topology or history
as information-theoretically necessary inputs for optimal play across the full
benchmark family.
