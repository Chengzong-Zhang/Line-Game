# LIFELINE-RL post-run submission gate v3

Gate date: 2026-08-31 (Asia/Shanghai)  
Role: independent post-run evidence and submission reviewer  
Candidate PDF SHA-256:
`AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`  
Post-run review:
`../reviews/iclr2027_postrun_independent_review_v3_ab99ec04.md`, SHA-256
`213FB10858AA2E94C2AE85B75CD6E10E95FC6AA32CC317149295090881D89451`

This is a new hash-bound gate for the rebuilt AB99 candidate. It does not
overwrite or reinterpret any A615 or B746 review, QA receipt, or gate; those
remain historical snapshots for different source and PDF bytes.

## Gate decision

**FAIL**

Entry to D23--D24: **NO**.  
D17--D19 performance claims admitted: **NONE**.  
D19 status: **NOT RUN; conditional gate closed**.

The candidate passes PDF, official-template, anonymity, corrected-method,
D14--D16 bounded-claim, local test, retained-environment-lock, and D17--D19
exclusion checks. Submission remains blocked by the absent author-confirmed
AI-use statement and live-form decision, the lack of an author-approved exact
anonymous supplement archive, and the lack of an independently verified fresh
clean-install reproduction receipt. Scientific acceptance risk also remains
high because the admitted learned-model evaluation has only two deterministic
trajectories per 200-game task and does not isolate logical-edge input.

## Bound evidence

| Artifact | SHA-256 |
| --- | --- |
| `paper/main.pdf` | `AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC` |
| `paper/main.tex` | `8C3C439363D63E85063B80703D604E9ABDED3689F0AD9AAF86AE398474A86D55` |
| `paper/references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| `paper/ICLR2027_POSTRUN_QA_AB99EC04.md` | `8C98F8FC82B2AB9E7FC4C35724334A69D6F2D97B7F9689864BEFC01C6DFCDA2B` |
| post-run independent review v3 | `213FB10858AA2E94C2AE85B75CD6E10E95FC6AA32CC317149295090881D89451` |
| `D14_D16_TERMINOLOGY_ERRATUM.md` | `275B303903A89C3C7697BC76A4E7D59E93325B281334CD9F6072DFD14FDDAF3E` |
| D14--D16 receipt ledger | `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114` |
| D14--D16 canonical aggregate | `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C` |
| D17/D18 local independent verifier report | `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E` |
| D14--D16 dependency lock | `CE828028578A87CAA31E7B3B69C0191458546533E21C0E1DE6180ACCDFBB879F` |
| retained-environment verification receipt | `FBAFAA8D7D748DEAD69B52EE042C79DCFBDE75675660FEEF1C53F167EDA97EB1` |
| supplement builder/verifier | `1E029292850C9755FDC4B54BEF1446AD05A5CEB30169656EC0E707BA90B702C7` |
| supplement allowlist | `23D854DF76FD2C9030F43106E7E66B1E3846C959E3604E3DDBECC70B4204802F` |
| supplement builder self-test | `287EEE80F1F4668BEBCF42BFFED4DBC7C84400DB3E6DA000F763BAC4523A8EA9` |

The D17/D18 verifier output remains in an ignored local result tree. Hash
binding it here does not add that tree to an anonymous submission package.

## Candidate identity, PDF, and template gate

| Check | Result |
| --- | --- |
| exact candidate/source hashes | PASS |
| official ICLR 2027 review style/BST | PASS |
| pages / paper size / rotation | 11 / US Letter / 0; PASS |
| main text and reproducibility statement | finish on page 8; PASS |
| all fonts embedded and subset | PASS |
| unencrypted / forms / JavaScript | yes / none / none; PASS |
| anonymous author block and empty author/title metadata | PASS |
| visible identity, email, local path, clipping, overlap, or broken glyph | none found; PASS |
| all-page render inspection | 11/11 PASS |
| AI-use statement present | **NO; FAIL / P0-A** |

The absence of an identity leak is not evidence of AI-policy compliance. The
mandatory statement must be author-confirmed and present in the rebuilt paper.

## Corrected method and terminology gate

| Check | Result |
| --- | --- |
| Eq. (3) self bias, relation mean, degree clamp, residual ReLU, LayerNorm | PASS |
| padded-node mask stated and implemented | PASS |
| Random/Greedy/Minimax/UCT-MCTS-16 behavior defined | PASS |
| `16` described only as simulation-count matching | PASS |
| 30,600 described as task-indexed records, not unique trajectories | PASS |
| independent-game or global-ranking claim | none; PASS |

The source correction changes no D14--D16 result, receipt, protocol, or
aggregate. The append-only terminology erratum preserves the historical
frozen documents rather than silently rewriting them.

## D14--D16 formal-evidence gate

The independent receipt audit returned `ok=true`: 330/330 complete receipts,
no failures or truncations, 1,500 self-play games, 3,000 gradient updates,
30,600 task-indexed replay-verified records, 72/72 canonical aggregate rows
with zero score/WDL/Wilson mismatch, and 630/630 sampled replays passed.

| Check | Result |
| --- | --- |
| artifact completeness and hash binding | PASS |
| seen-size 5/7/9 descriptive claim scope | PASS |
| repeated-trajectory limitation retained | PASS |
| independent-game inference | not claimed; PASS |
| global representation ranking | not claimed; PASS |
| logical-edge causal effect | not claimed; PASS |

This gate admits the bounded D14--D16 artifact and descriptive results only.
It does not imply that the experimental evidence is strong enough for
acceptance.

## D17--D19 fail-closed gate

| Check | Required | Observed | Result |
| --- | ---: | ---: | --- |
| complete / independently verified tasks | 85 / 85 | 85 / 85 | PASS |
| failed-or-invalid / missing / extra tasks | 0 / 0 / 0 | 0 / 0 / 0 | PASS |
| replayed / expected games | 8,320 / 8,320 | 8,320 / 8,320 | PASS |
| truncated games | 0 | 0 | PASS |
| D17 task diversity gates | 40/40 | 40/40 | PASS |
| D18 task diversity gates | 45/45 | 23/45; 22 failed | **FAIL** |
| canonical numeric equality | required | not established | FAIL_CLOSED |
| global `formal_ready` | `true` | `false` | **FAIL_CLOSED** |
| D19 conditional prerequisites | all frozen gates pass | not met | CLOSED; 0 rows |

Execution completeness does not override the scientific gate. The PDF contains
no D17--D19 performance score, interval, significance, generalization,
D16-v2, or matched-architecture result. The failure thresholds remain frozen.

## Local code and environment gate

| Check | Result |
| --- | --- |
| complete research test suite | 261 passed + 174 passing subtests |
| supplement builder self-test | 10 passed; 1 host-capability symlink skip |
| simulated reparse-point rejection | PASS |
| `ruff check` / `git diff --check` | PASS / PASS |
| exact 19-package lock | PASS |
| retained `rl310` environment vs. formal metadata | `ok=true`, zero errors |
| fresh clean environment installed from lock | **NOT VERIFIED** |
| independent reproduction from a final anonymous archive | **NOT AVAILABLE** |

The dependency-specification gap in v2 is partly closed: an exact lock and
matching retained-environment receipt now exist. This is not a fresh-install
or cross-machine reproduction result.

## Submission matrix

| Domain | Status | Evidence and boundary |
| --- | --- | --- |
| candidate identity | PASS | AB99 PDF/source hashes match QA and review |
| template / page / render / font / anonymity | PASS | 11/11 pages inspected; metadata and path scans pass |
| corrected method and baseline text | PASS | Eq. (3) and baseline definitions checked against code |
| D14--D16 number boundary | CONDITIONAL PASS | frozen seen-size results remain descriptive and limited |
| D17--D19 execution completeness | PASS | 85/85 tasks, 8,320/8,320 games |
| D17--D19 scientific formal gate | FAIL_CLOSED | 22/45 D18 diversity gates failed; D19 closed |
| D17--D19 paper exclusion | PASS | no failed-bundle performance row admitted |
| headline uncertainty framing / historical P0-C | CLOSED for AB99 | no Wilson/lower-bound headline in abstract or conclusion |
| dependency lock and retained-env identity | PASS | exact lock plus `ok=true` local receipt |
| fresh clean-install reproduction | NOT VERIFIED | retained environment only |
| supplement builder safeguards | PASS | strict deterministic candidate-only tool and self-test |
| author-approved anonymous supplement | **FAIL / P0-B** | no final candidate/archive/identity profile/gate |
| self-contained final reproduction package | **FAIL / P0-D** | no independently gated exact submission bytes |
| AI-use policy | **FAIL / P0-A** | no author-confirmed paper statement or live-form answer |
| live submission form | NOT VERIFIED | requires author action in the live system |

## Minimum closure conditions

Author side:

1. Complete the AI-use worksheet with all authors; approve and add the final
   statement to the paper; complete the separate live-form disclosure.
2. Review and approve every supplement allowlist entry and the release scope.
   Provide the private identity-term profile locally, build a new candidate,
   scan and hash the exact archive, and obtain an independent clean-copy gate.
3. Verify the final live submission form and candidate metadata in the actual
   system.

Reproduction side:

1. Install from the exact lock in a fresh environment and run the candidate's
   documented checks; record a hash-bound receipt.
2. Bind the final archive, manifest, privacy receipt, allowlist, and clean-copy
   outputs to a new submission gate. Candidate-only tooling is not the archive.

Research side:

1. Preserve D17/D18 v1 unchanged and keep all failed-bundle performance rows
   out of the paper.
2. If a replacement evaluation is approved, use a prospectively frozen new
   protocol, openings, manifest, experiment ID, runner identity, and run root.
   Do not lower observed diversity thresholds.
3. Keep D19 disabled unless all prerequisites pass and paid execution receives
   separate live authorization.

Independent re-gate:

1. Any paper or PDF byte change requires a new QA receipt, independent review,
   and gate.
2. Recheck the exact author-approved supplement archive, fresh-environment
   receipt, AI statement, anonymity, claims, and live form together.

## Final decision

Current gate: **FAIL**.  
Entry to D23--D24: **NO**.  
PDF/technical QA: **PASS for AB99**.  
D14--D16 bounded formal evidence: **ADMITTED**.  
D17--D19 performance claims admitted: **NONE**.  
Author AI-use confirmation: **OPEN**.  
Final anonymous supplement: **OPEN**.

This decision is bound to PDF SHA-256
`AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`,
review SHA-256
`213FB10858AA2E94C2AE85B75CD6E10E95FC6AA32CC317149295090881D89451`,
and D17/D18 verifier report SHA-256
`2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`.
