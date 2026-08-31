# Independent ICLR 2027 review v5 - current-hash rebind

Review date: 2026-08-31 (Asia/Shanghai)

Manuscript SHA-256:

`2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`

- Pages: 11, US Letter
- Recommendation: **Reject**
- Overall score: **4/10**
- Confidence: **4/5**

This is a fresh review of the exact current PDF, not a claim that the PDF is
submission-ready. The current pages were rendered and inspected in full. They
are pixel-identical at 150 dpi to the earlier independently reviewed
`69247087...D73B88C` page set, but the new byte hash required a new binding.

## Summary

LIFELINE-RL is a deterministic self-play benchmark that separates rendered
occupancy, player-specific logical connectivity, cascading removal, and
history-dependent repetition. It reports exhaustive side-five diagnostics, a
side-six Superko trace, bounded larger-board searches, and a small AlphaZero-
style comparison of a padded CNN, physical-edge Grid-GNN, and typed-edge
Topology-GNN on jointly trained sizes 5, 7, and 9.

The manuscript is unusually disciplined about evidence boundaries. It treats
the D14-D16 neural results as five-seed descriptive summaries, discloses that
each 200-game round-robin task repeats only two deterministic trajectories,
and declines to claim a global representation ranking, unseen-size transfer,
sample efficiency, or inferential significance.

## Strengths

1. Claim types, budgets, failures, and excluded evidence are stated clearly.
2. The separation of occupancy, logical topology, and repetition history is a
   technically interesting benchmark-design problem.
3. Counts, seeds, task/receipt totals, search budgets, and known effective-
   sample-size limits are unusually transparent.
4. Exhaustive negatives, budgeted misses, pilots, and failed gates are not
   promoted into positive results.
5. The 11-page paper is coherent, readable, anonymous, and visually intact.

## Score-driving weaknesses

### P0-1: Decision-relevant topology or history is not established

At side five, every reachable Grid-equivalent pair agrees in legal actions,
one-step Grid observations, exact value, shared-action values, and optimal
actions. The side-six trace proves that Superko can bind, but it is not the
paired-state witness needed to show that an omitted topology/history feature
creates a decision-relevant ambiguity. The bounded larger-board search did
not find such a witness.

The benchmark therefore demonstrates latent topology differences and an
active repetition rule, but not yet a strategically meaningful ambiguity in
the evaluated learning problem.

### P0-2: The neural comparison is not a controlled causal ablation

Grid-GNN and Topology-GNN differ in relation types and hidden width; the CNN
is a different model family. FLOPs, memory, transitions, evaluation compute,
and wall time are not matched. `TopologyHistory` is not part of the formal
neural comparison, and logical-edge/history channels are not toggled within a
single compute-matched architecture. The results cannot isolate the effect of
topology, history, or architecture.

### P0-3: Evaluation diversity and opponent calibration are inadequate

There are five training seeds per cell, but each deterministic 200-game task
contains only two color-conditioned trajectories repeated 100 times. Random
is a low bar, and UCT-MCTS-16 is not calibrated as a stable strength measure
across sizes. There is no prospectively frozen diverse-opening evaluation,
uncertainty at a valid independent unit, formal paired comparison, or search-
budget sweep.

### P1 issues

- The PDF alone under-specifies protected regions, attack/cascade rules,
  automatic skips, Superko canonicalization, and territory scoring.
- Learned evidence covers one hand-designed game and jointly trained seen
  sizes 5, 7, and 9; external validity and unseen-size transfer are untested.
- Training and search budgets are small, and the broader search matrix remains
  an engineering smoke test rather than a formal baseline result.

## Artifact-informed assessment

- D14-D16: 330/330 receipts and compact evidence reconcile, but the admitted
  status remains `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`.
- D17/D18-v1: execution completed 85/85 tasks and 8,320/8,320 games, yet 22 of
  45 D18 trajectory-diversity gates fail and `formal_ready=false`.
- D19: closed by the failed D17/D18 gate.
- D18-v3: task/job/stage candidates exist, but no formal-run receipts or
  independent verification exist; formal evidence is zero.
- Claim-complete packaging and subject binding are materially stronger, but a
  real identity list, author approval, final archive, and clean-install receipt
  remain absent.
- The paper still lacks the required author-confirmed AI-use statement, and
  the live OpenReview form was not verified.

These facts increase confidence in bounded accounting, not in the central
scientific effect.

## Presentation and technical quality

Technical/rendering QA passes for the exact current PDF. All pages, figures,
tables, equations, and references are readable; fonts are embedded/subset;
metadata is anonymous; there are no attachments, forms, JavaScript, or broken
citations. Minor issues are the loose justified spacing in artifact-heavy
captions on pages 6-7 and substantial unused space on page 11.

## What would change the recommendation

1. A replay-verifiable naturally reachable witness, or rigorous larger-board
   result, where omitting topology/history changes a legal shared action,
   transition, value, or optimal action.
2. A prospectively frozen single-architecture ablation that toggles logical
   edges and history independently under credible compute matching.
3. A diverse paired-opening or stochastic evaluation with a valid independent
   unit, uncertainty, and stronger calibrated opponents or a search sweep.
4. A complete anonymous benchmark contract with precise rules, clean-install
   reproduction, and verifier-backed compact artifacts.

More deterministic repetitions, cosmetic edits, or stronger bookkeeping alone
would not change the 4/10 score. If the first three scientific items produced
a consistent, valid effect and the fourth passed independently, the work could
move toward borderline accept.

## Scope receipt

The current PDF was read, text-extracted, and visually checked on all 11 pages.
Repository evidence was opened only after the scientific assessment was
confirmed. No manuscript source, experiment evidence, protocol, or frozen
receipt was modified by this review. No network access, upload, submission,
training, GPU work, paid compute, commit, push, or publication action occurred.
