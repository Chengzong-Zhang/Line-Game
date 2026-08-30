# LIFELINE-RL ICLR 2027 post-run independent review v2

## Hash binding and review protocol

- Review object: `research/iclr2027/paper/main.pdf`
- PDF SHA-256:
  `B746777E1D525BC43F1AC823C5F9CFCEF629861273BB47F699740BDEFF543D0E`
- Source SHA-256:
  `DCC791432DBF6728703AC0F53B502DD219D1F472BAB94F86B238B501D432F3E4`
- Review date: 2026-08-30 (Asia/Shanghai)
- Post-run PDF QA receipt:
  `paper/ICLR2027_POSTRUN_QA_B746777E.md`, SHA-256
  `5599C834A5A8C77A4AC6E4916B2743FB6C3FB39AB5A64C3DCE540737105F27D6`
- Local independent verifier report SHA-256:
  `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`
- Independent numeric interface SHA-256:
  `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19`
- Fail-closed summary SHA-256:
  `3303D00A1601FD0137B3B5EDF1EE98A29A53BE7861264CAE1D478A277722C87F`

This is a new review of the rebuilt `B746777E...543D0E` candidate. It does
not rewrite or retroactively rescore the hash-bound `A615857B...127B75`
review, gate, or QA receipt. The historical A615 review and gate remain
immutable at SHA-256
`D3E0D51392EB630B87939397A7F76AD6EF1ECCAD5A2E2D9933961246F2DF121E`
and
`E7662946B6F3E0026171B10A98F5AAC6AE86F6C9C96EBBEB6953D077770E1FFF`,
respectively.

Any byte change to `main.pdf` invalidates the PDF findings below. Any byte
change to the independent verifier report invalidates the D17/D18 evidence
findings.

The review was read-only. All 11 PDF pages were freshly rendered at 144 dpi
and inspected. PDF metadata, fonts, page geometry, and extracted text were
rechecked. The verifier JSON was parsed directly, and the task, game,
experiment, and diversity counts were recomputed from its task-level audit
rows using the frozen verifier thresholds. No comparison score, W/D/L,
confidence interval, or other D17-D19 performance row was admitted as a paper
claim.

## Overall assessment

**Recommendation: Weak Reject / Needs revision. Submission gate: FAIL.**

The rebuilt candidate closes the earlier pooled-Wilson headline-framing issue
for this exact PDF hash. The abstract now describes UCT-MCTS-16 results only
as pooled descriptive evidence, and neither the abstract nor conclusion makes
a Wilson or lower-bound headline claim. This closes P0-C for B746 only; it
does not validate independent-game inference or broaden the admitted D14-D16
claim scope.

Submission remains blocked by the missing author-confirmed AI-use statement
and live-form disclosure, the absence of an anonymous independently gated
supplement, the incomplete self-contained executable reproduction package,
the missing dependency-lock/container receipt, and the unverified final live
submission form.

Execution completion and scientific admissibility remain separate: 85/85
tasks and 8,320/8,320 games completed, but D18 failed 22/45 frozen
trajectory-diversity gates. The global bundle is therefore
`formal_ready=false`; D19 remained gated off.

## Independent post-run evidence audit

The authoritative local inputs are under:

`results/formal/d17_d19/run_20260830_p0_autodl_canonical_v1/verification/local_independent_v1/`

| Check | Independently observed | Decision |
| --- | ---: | --- |
| expected / receipt / verified tasks | 85 / 85 / 85 | PASS |
| failed-or-invalid / missing / extra tasks | 0 / 0 / 0 | PASS |
| replayed / expected games | 8,320 / 8,320 | PASS |
| truncated games | 0 | PASS |
| paired-color units | 4,160 | PASS |
| D17 tasks / games | 40 / 2,560 | COMPLETE |
| D17 task diversity gates | 40/40 passed | PASS |
| D18 tasks / games | 45 / 5,760 | COMPLETE |
| D18 task diversity gates | 23/45 passed; 22/45 failed | FAIL |
| canonical numeric equality | not established | FAIL_CLOSED |
| global `formal_ready` | `false` | FAIL_CLOSED |
| D19 task or comparison rows | 0 | NOT RUN; gate closed |

The 22 D18 failures are scientific gate failures, not execution failures.
Recomputation from the 45 D18 task audit rows found:

- 22 tasks below the frozen minimum of 64 unique full trajectories;
- 15 of those tasks also below the minimum of 24 opening clusters with at
  least two distinct continuations;
- zero tasks below the separate minimum of 32 unique continuations;
- failures distributed as 15 side-five, five side-seven, and two side-nine
  tasks.

The verifier records `unique_trajectory_thresholds_met=false`. It also leaves
`canonical_hash_verified=false` and `canonical_numeric_match=false`, so its
status is `FAIL_CLOSED`. The local independent numeric file is bound for audit
traceability, but its diagnostic comparison rows are not admitted evidence.
All other reported manifest, ledger, receipt, replay, pairing, hash-binding,
seed-interval, and crossed-cluster-interval gates passed.

These facts support a fail-closed routing decision only. They do not authorize
publication of any D17, D18, or D19 comparison row.

## Current PDF claim-boundary review

The extracted B746 PDF text contains no literal D17, D18, or D19 label and no
D17-D19 score, W/D/L, interval, significance, generalization, or model-ordering
claim. Its only post-run scientific statement says that a later diversified
extension executed its planned games, failed the frozen trajectory-diversity
gate, and is excluded.

The following boundaries are correctly present:

- unseen-size generalization requires a gate-passing formal result;
- the admitted empirical tables remain D14-D16, seen-size evidence;
- `formal_ready=true` is explicitly scoped to the completed D14-D16 bundle;
- the original D16 duplicated-trajectory limitation remains open;
- a prospective replacement evaluation and independent verification remain
  future work;
- no D19 architecture-matched ablation claim appears.

**D17-D19 claim-boundary decision: PASS.** This pass means only that the failed
bundle is excluded correctly. It is not a pass of the experiment.

## P0-C review: headline uncertainty framing

The B746 abstract states only that scores against the fixed UCT-MCTS-16
opponent vary by model and size and are reported as pooled descriptive
evidence. The conclusion contains no Wilson, interval, or lower-bound headline
language.

The body still contains descriptive Wilson intervals and one sentence saying
that seven D14-D16 cells have descriptive lower bounds above 0.5. Those details
remain explicitly paired with the facts that each 200-game task repeats only
two deterministic trajectories, pooled games are not treated as independent,
and no independent-game or multiple-comparison inference is claimed.

**P0-C status: CLOSED for PDF SHA-256 `B746777E...543D0E`.** This is a closure
of the headline-framing gate only. It does not establish frequentist coverage,
independent trials, a global representation ranking, or a valid replacement
for the failed D18 bundle. A changed PDF requires a new hash-bound review.

## PDF and presentation integrity

The post-run QA receipt was cross-checked against the live file:

- 11 pages, US Letter 612 x 792 pt, rotation 0;
- unencrypted, no form, and no JavaScript;
- every listed font embedded and subset;
- author and title metadata empty;
- visible anonymous-author block under the official ICLR 2027 review style;
- no visible identity, local path, clipping, overlap, broken table, black
  square, unreadable glyph, visible link box, or accidental blank tail page;
- five tables and three vector figures remain legible;
- extracted text contains no final AI-use statement, D17-D19 label, local
  path, or author identity hit.

Page 11 retains substantial intentional whitespace after the appendix text.
This is not a rendering failure, but it leaves room for a more self-contained
executable specification or artifact inventory.

## Remaining open P0 gates

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

### P0-D: the benchmark is not independently reconstructable from the current submission package

The manuscript describes the main rule components and points to receipts,
hashes, aggregates, and verifier outputs, but no anonymous executable package
currently supplies the complete transition specification, canonical state
identity, witness inputs, solver/verifier contract, and one-command clean-copy
reproduction path.

**Status: OPEN; overlaps with, but is not closed merely by, P0-B.**

## Other release gates still open

- No final dependency lock, container digest, or independently tested clean
  environment receipt is bound to the candidate.
- The final live submission form, including the separate AI-use disclosure,
  has not been verified by an author in the live system.

## Remaining scientific and engineering limits

- Grid-GNN and Topology-GNN still differ in relation structure and hidden
  width; existing direct play is not a logical-edge causal ablation.
- FLOPs, memory, transitions, wall time, and evaluation compute are not fully
  matched.
- External validity beyond one hand-designed game remains untested.
- The D17/D18 v1 artifacts must remain immutable. A replacement D18 run needs
  a new protocol version, openings, manifest, experiment ID, runner identity,
  and run root; frozen thresholds must not be lowered after observing failure.
- D19 must remain disabled until its frozen prerequisites pass and any paid
  action receives separate live authorization.

## Final recommendation

Do not enter D23-D24 and do not add D17, D18, or D19 performance numbers to
this candidate. Preserve the failed v1 run as evidence. The highest-priority
next work is author confirmation and the mandatory AI-use statement, an
anonymous independently gated supplement/reproduction package, dependency
locking or a tested container receipt, and final live-form verification. A
prospectively frozen replacement experiment is a separate optional research
decision and cannot repair the current submission gate by itself.

**Final recommendation: Weak Reject / Needs revision. Confidence: 0.90.**

This report applies only to PDF SHA-256
`B746777E1D525BC43F1AC823C5F9CFCEF629861273BB47F699740BDEFF543D0E`
and verifier report SHA-256
`2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`.
