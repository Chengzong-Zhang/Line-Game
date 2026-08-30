# LIFELINE-RL ICLR 2027 post-run independent review

## Hash binding and review protocol

- Review object: `research/iclr2027/paper/main.pdf`
- PDF SHA-256:
  `A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75`
- Source SHA-256:
  `7C95EA32B8140A95075D80040EAEFD6E0BF67789D3D909840511C26DA63A791A`
- Review date: 2026-08-30 (Asia/Shanghai)
- Post-run PDF QA receipt:
  `paper/ICLR2027_POSTRUN_QA_A615857B.md`, SHA-256
  `E07306045A4F11C72B56D186790510327C0FC13AA1A1EA59F9B4A288C48F108D`
- Local independent verifier report SHA-256:
  `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`
- Independent numeric interface SHA-256:
  `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19`
- Fail-closed summary SHA-256:
  `3303D00A1601FD0137B3B5EDF1EE98A29A53BE7861264CAE1D478A277722C87F`

This is a new post-run snapshot. It does not rewrite or retroactively rescore
the hash-bound Round 1, Round 2, blind-first, or submission-gate snapshots.
Any byte change to `main.pdf` invalidates the PDF findings below. Any byte
change to the verifier report invalidates the D17/D18 evidence findings.

The review was read-only. All 11 PDF pages were rendered and inspected; PDF
metadata, fonts, page geometry, and extracted text were checked. The verifier
JSON was parsed directly, and task, game, experiment, and diversity counts
were recomputed from its task-level audit rows. No comparison score, W/D/L,
confidence interval, or other performance row was used as an admitted claim.

## Overall assessment

**Recommendation: Weak Reject / Needs revision. Submission gate: FAIL.**

The current candidate correctly excludes D17--D19 performance conclusions and
clearly scopes `formal_ready=true` to the completed D14--D16 bundle. This
specific claim-boundary repair passes. It does not make the D17/D18 bundle
formal-ready and does not close the existing author-confirmation, AI-use,
anonymous-supplement, uncertainty, or self-contained-reproducibility gates.

Execution completion and scientific admissibility must remain separate:
85/85 tasks and 8,320/8,320 games completed, but D18 failed 22/45 frozen
trajectory-diversity gates. The global bundle is therefore
`formal_ready=false`; D19 remained gated off.

## Independent post-run evidence audit

The authoritative inputs are the files under:

`results/formal/d17_d19/run_20260830_p0_autodl_canonical_v1/verification/local_independent_v1/`

| Check | Independently observed | Decision |
| --- | ---: | --- |
| expected / receipt / verified tasks | 85 / 85 / 85 | PASS |
| failed-or-invalid / missing / extra tasks | 0 / 0 / 0 | PASS |
| replayed / expected games | 8,320 / 8,320 | PASS |
| truncated games | 0 | PASS |
| paired-color units | 4,160 | PASS |
| D17 task diversity gates | 40/40 passed | PASS |
| D18 task diversity gates | 23/45 passed; 22/45 failed | FAIL |
| canonical numeric interface supplied | no | FAIL_CLOSED |
| global `formal_ready` | `false` | FAIL_CLOSED |
| D19 tasks executed | 0 | NOT RUN; gate closed |

The 22 D18 failures are scientific gate failures, not execution failures.
Recomputation from the 45 D18 task audit rows found:

- 22 tasks below the frozen minimum of 64 unique full trajectories;
- 15 of those tasks also below the minimum of 24 opening clusters with at
  least two distinct continuations;
- zero tasks below the separate minimum of 32 unique continuations;
- failures distributed as 15 side-five, five side-seven, and two side-nine
  tasks.

The verifier correctly records
`unique_trajectory_thresholds_met=false`. It also leaves
`canonical_hash_verified=false` and `canonical_numeric_match=false` because a
canonical numeric interface was not supplied. All other reported manifest,
ledger, receipt, replay, pairing, hash-binding, seed-interval, and
crossed-cluster-interval gates passed.

These facts support a fail-closed routing decision only. They do not authorize
publication of the comparison rows stored in the independent numeric file.

## Current PDF claim-boundary review

The live PDF contains no literal D17, D18, or D19 label and no D17--D19 score,
W/D/L, interval, significance, or model-ordering result. Its only post-run
scientific statement says that a later diversified extension executed its
planned games, failed the frozen trajectory-diversity gate, and is excluded.

The following boundaries are correctly present:

- unseen-size generalization requires a gate-passing formal result;
- the admitted empirical tables remain D14--D16, seen-size evidence;
- `formal_ready=true` is explicitly scoped to the D14--D16 ledger;
- the original D16 duplicated-trajectory limitation remains open;
- a prospective replacement evaluation and independent verification remain
  future work;
- no D19 architecture-matched ablation claim appears.

**D17--D19 claim-boundary decision: PASS.** This pass means only that the
failed bundle is excluded correctly. It is not a pass of the experiment.

## PDF and presentation integrity

The post-run QA receipt was cross-checked against the live file:

- 11 pages, US Letter 612 x 792 pt, rotation 0;
- unencrypted, no form, and no JavaScript;
- every listed font embedded and subset;
- author and title metadata empty;
- visible anonymous-author block under the official ICLR 2027 review style;
- no visible identity, local path, clipping, overlap, broken table, black
  square, unreadable glyph, or accidental blank tail page;
- five tables and three vector figures remain legible.

Page 11 retains substantial intentional whitespace. This is not a rendering
failure, but it leaves room for a more self-contained executable specification
or artifact inventory.

## Open P0 gates

### P0-A: author-confirmed AI-use disclosure is absent

Neither the live PDF nor extracted PDF text contains the mandatory AI-use
statement. `AI_USE_DISCLOSURE_DRAFT.md` remains a worksheet, not an
author-confirmed statement and not the separate live submission-form answer.

Closure requires every author to confirm the tools, paper-relevant tasks,
retained outputs, unpublished-material handling, and human verification; add
the final statement to the paper; complete the live form; rebuild; and rerun
the gate on the new PDF hash. If this simulated review affects the manuscript
or form, that use also requires accurate author confirmation.

**Status: OPEN; blocks final submission.**

### P0-B: anonymous, hash-bound supplement is absent

No `supplement/RELEASE_CLAIM_DELTA.md`, anonymous allowlist directory, or
independently gated supplement archive was found. Narrow release wording does
not create a reproducibility package. The ignored D17/D18 result tree and its
local-only fail-closed audit are not submission artifacts.

Closure requires an explicit allowlist, identity/absolute-path/remote and
metadata scans, a complete hash manifest, clean-copy reproduction checks, and
independent verification of the exact archive offered for submission.

**Status: OPEN; blocks the project-defined final submission gate.**

### P0-C: pooled Wilson lower-bound language remains a headline claim

The abstract still reports that seven of nine descriptive Wilson lower bounds
exceed 0.5. The same PDF acknowledges that each D16 200-game task repeats only
two deterministic trajectories and that pooled games are not independent.
Calling the intervals descriptive does not restore frequentist coverage.

The minimum repair remains removal of lower-bound/interval language from the
abstract and headline conclusion. A stronger repair would use an admitted,
prospectively diversified, seed/opening/task-level analysis. The failed D18
bundle cannot supply that repair.

**Status: OPEN; blocks treating the headline uncertainty claim as validated.**

### P0-D: the benchmark is not independently reconstructable from the current submission package

The manuscript describes the main rule components and points to receipts,
hashes, aggregates, and verifier outputs, but no anonymous executable package
currently supplies the complete transition specification, canonical state
identity, witness inputs, solver/verifier contract, and one-command clean-copy
reproduction path.

**Status: OPEN; overlaps with, but is not closed merely by, P0-B.**

## Remaining scientific and engineering limits

- Grid-GNN and Topology-GNN still differ in relation structure and hidden
  width; existing direct play is not a logical-edge causal ablation.
- FLOPs, memory, transitions, wall time, and evaluation compute are not fully
  matched.
- External validity beyond one hand-designed game remains untested.
- Dependency locking/containerization remains open.
- The D17/D18 v1 artifacts must remain immutable. A replacement D18 run needs
  a new protocol version, openings, manifest, experiment ID, runner identity,
  and run root; frozen thresholds must not be lowered after observing failure.
- D19 must remain disabled until its frozen prerequisites pass and any paid
  action receives a separate live authorization.

## Final recommendation

Do not enter D23--D24 and do not add D17, D18, or D19 performance numbers to
this candidate. Preserve the failed v1 run as evidence. The highest-priority
next work is author confirmation and the mandatory AI-use statement, an
anonymous independently gated supplement/reproduction package, removal or
redesign of the pooled-Wilson headline claim, and only then a prospectively
frozen replacement experiment if the authors choose to pursue it.

**Final recommendation: Weak Reject / Needs revision. Confidence: 0.90.**

This report applies only to PDF SHA-256
`A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75`
and verifier report SHA-256
`2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`.
