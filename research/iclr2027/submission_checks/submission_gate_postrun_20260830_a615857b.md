# LIFELINE-RL post-run submission gate

Gate date: 2026-08-30 (Asia/Shanghai)  
Role: independent post-run evidence and submission reviewer  
Candidate PDF SHA-256:
`A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75`  
Post-run review:
`../reviews/iclr2027_postrun_independent_review_a615857b.md`, SHA-256
`D3E0D51392EB630B87939397A7F76AD6EF1ECCAD5A2E2D9933961246F2DF121E`

This is a new hash-bound gate. It does not overwrite or reinterpret
`submission_gate.md`, which remains a historical snapshot for a different PDF.

## Gate decision

**FAIL**

Entry to D23--D24: **NO**.

The live PDF passes current-candidate hash, template, anonymity, page,
rendering, and D17--D19 exclusion checks. Submission remains blocked by the
missing author-confirmed AI-use statement and live-form decision, the absence
of an anonymous independently gated supplement/reproduction package, the
pooled-Wilson headline claim, and the incomplete self-contained reproduction
contract. D17/D18 execution completion does not override any of these gates.

## Bound evidence

| Artifact | SHA-256 |
| --- | --- |
| `paper/main.pdf` | `A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75` |
| `paper/main.tex` | `7C95EA32B8140A95075D80040EAEFD6E0BF67789D3D909840511C26DA63A791A` |
| `paper/references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| `paper/ICLR2027_POSTRUN_QA_A615857B.md` | `E07306045A4F11C72B56D186790510327C0FC13AA1A1EA59F9B4A288C48F108D` |
| `paper/CLAIM_EVIDENCE_LIMITATION_V3.md` | `0DE608D16B13EF04D6FF028DB215A157D8CCD5581FF548040B3D79E3B3AB5EBA` |
| D17/D18 `result_receipts.jsonl` | `09AFC03CADFC54CC143D7049DFE78328C1665B3F698274C26A4DBF711C0F080A` |
| local `independent_verification.json` | `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E` |
| local `independent_numeric.json` | `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19` |
| local `FAIL_CLOSED_SUMMARY.md` | `3303D00A1601FD0137B3B5EDF1EE98A29A53BE7861264CAE1D478A277722C87F` |

The local verifier outputs remain inside the ignored D17--D19 result tree.
Hash binding them here does not add them to an anonymous submission package.

## PDF and template gate

The gate routes PDF-specific checks through
`paper/ICLR2027_POSTRUN_QA_A615857B.md` and independently rechecked the live
file identity.

| Check | Result |
| --- | --- |
| exact candidate SHA-256 | PASS |
| official ICLR 2027 review style | PASS |
| style / BST SHA-256 | `797DEEF4...98EA6` / `2D67552D...44C5` |
| pages / paper size / rotation | 11 / US Letter / 0; PASS |
| all fonts embedded and subset | PASS |
| anonymous author block and empty author/title metadata | PASS |
| visible identity, local path, clipping, overlap, or broken glyph | none found; PASS |
| all-page render inspection | 11/11 PASS |

These checks close rendering for this exact hash only. They do not close the
AI policy, supplement, scientific-claim, or final submission-form gates.

## D17--D19 fail-closed gate

| Check | Required | Observed | Result |
| --- | ---: | ---: | --- |
| complete task receipts | 85 | 85 | PASS |
| independently verified tasks | 85 | 85 | PASS |
| failed-or-invalid / missing / extra tasks | 0 / 0 / 0 | 0 / 0 / 0 | PASS |
| replayed games | 8,320 | 8,320 | PASS |
| truncated games | 0 | 0 | PASS |
| D17 task diversity gates | 40/40 | 40/40 | PASS |
| D18 task diversity gates | 45/45 | 23/45; 22/45 failed | **FAIL** |
| independent canonical numeric equality | required | not supplied | FAIL_CLOSED |
| global `formal_ready` | `true` | `false` | **FAIL_CLOSED** |
| D19 conditional prerequisites | all P0 gates pass | not met | CLOSED; 0 tasks run |

The D18 failures are trajectory-diversity failures, not execution, delivery,
receipt, or replay failures. The verifier report has
`unique_trajectory_thresholds_met=false`; its other manifest, receipt, replay,
hash-binding, pairing, and registered-interval gates pass. Because the formal
gate is conjunctive, 85/85 completed tasks cannot be summarized as formal
evidence ready.

The independent numeric file contains non-admitted diagnostic comparison
rows. No D17, D18, or D19 performance score, W/D/L, interval, significance,
generalization, D16-v2 conclusion, or architecture-matched conclusion may be
copied into the current candidate.

## Candidate claim-boundary gate

| Check | Result |
| --- | --- |
| D14--D16 `formal_ready=true` explicitly scoped | PASS |
| original D16 repeated-trajectory limitation retained | PASS |
| later diversified extension described as failed and excluded | PASS |
| D17--D19 performance number in PDF | none found; PASS |
| n=10/12 generalization claim | none; PASS |
| D16-v2 performance/inference claim | none; PASS |
| D19 matched-architecture result claim | none; PASS |

This section passes only the exclusion boundary. It does not change the failed
D17/D18 experiment gate.

## Submission matrix

| Domain | Status | Evidence and boundary |
| --- | --- | --- |
| candidate identity | PASS | PDF and source hashes match the post-run QA receipt |
| official template | PASS | official ICLR 2027 style/BST hashes retained |
| page/render/font QA | PASS | 11-page US-Letter candidate; 11/11 pages inspected |
| PDF anonymity | PASS | anonymous block; empty author/title metadata; no identity/path hit |
| D14--D16 number boundary | CONDITIONAL PASS | frozen seen-size results remain descriptive and scope-limited |
| D17--D19 execution completeness | PASS | 85/85 tasks and 8,320/8,320 games |
| D17--D19 scientific formal gate | FAIL_CLOSED | 22/45 D18 diversity gates failed; canonical numeric equality absent |
| D17--D19 paper exclusion | PASS | no performance result admitted |
| AI-use policy | **FAIL / P0** | no author-confirmed paper statement or live-form decision |
| anonymous supplement | **FAIL / P0** | no allowlisted, identity-scanned, hash-bound archive |
| headline uncertainty claim | **FAIL / P0** | pooled Wilson lower-bound language remains in abstract |
| self-contained reproduction package | **FAIL / P0** | no independently gated executable benchmark package |
| dependency lock/container | NEEDS REVISION | no final locked clean environment receipt |
| live submission form | NOT VERIFIED | requires author action in the live system |

## Open P0 gates

### P0-A: AI-use statement and author confirmation

`AI_USE_DISCLOSURE_DRAFT.md` remains an unconfirmed worksheet. Every author
must confirm the actual tools, stages, retained outputs, unpublished-material
handling, and human verification. The final statement must be added to the
paper and the separate live-form disclosure must be completed. A new PDF hash
then requires a new gate.

### P0-B: anonymous supplement and release contract

No `supplement/RELEASE_CLAIM_DELTA.md`, anonymous allowlist, independently
scanned archive, or supplement hash is available. The whole repository is not
a safe substitute. The local D17/D18 result tree is ignored and explicitly
outside the current submission artifacts.

### P0-C: pooled Wilson headline language

The abstract still elevates descriptive pooled-game Wilson lower bounds even
though deterministic duplication invalidates an independent-game sampling
interpretation. Remove the lower-bound headline or replace it only with a
future analysis that independently passes a prospectively frozen gate. The
failed D18 run cannot be used for that replacement.

### P0-D: self-contained benchmark reproduction

The exact anonymous submission package must provide or explicitly scope the
transition specification, canonical state identity, witness/verifier inputs,
solver contract, and a tested clean-copy reproduction command. Repository
references and local-only evidence do not close this gate.

## Minimum closure conditions

Author side:

1. Complete the AI-use confirmation worksheet with every author, add the final
   statement to the paper, and complete the live submission-form disclosure.
2. Remove or adequately redesign the pooled-Wilson headline claim.
3. Build an anonymous allowlisted supplement/reproduction package; scan names,
   usernames, absolute paths, remotes, metadata, and archive member names; bind
   the exact archive with SHA-256.
4. Provide and test the complete clean-copy benchmark reproduction contract.
5. Lock the dependency environment or provide an equivalent independently
   tested container/lock receipt.

Research side:

1. Preserve the D17/D18 v1 run, receipts, thresholds, and failure report
   unchanged. Do not relabel execution completion as formal readiness.
2. Keep all D17--D19 performance rows out of the current paper.
3. If a replacement is authorized, use an append-only D18-v3 protocol with a
   new opening set, manifest, experiment ID, runner identity, and run root.
4. Keep D19 disabled unless all frozen prerequisites pass; any paid action
   still requires separate live confirmation.

Independent re-gate:

1. Rebuild after every paper change and bind the new `main.pdf` SHA-256.
2. Bind and independently inspect the exact anonymous supplement archive.
3. Re-run PDF, anonymity, claim, reproducibility, AI-policy, and submission-form
   checks. Do not carry this gate forward to a changed candidate.

## Final decision

Current gate: **FAIL**.  
Entry to D23--D24: **NO**.  
D17--D19 performance claims admitted: **NONE**.  
D19 status: **NOT RUN; conditional gate closed**.

This decision is bound to PDF SHA-256
`A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75`
and verifier report SHA-256
`2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`.
