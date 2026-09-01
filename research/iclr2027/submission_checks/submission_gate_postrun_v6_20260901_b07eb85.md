# LIFELINE-RL post-run submission gate v6

- Gate date: 2026-09-01 (Asia/Shanghai)
- Canonical-closure subject commit: `b07eb852573acb6a635d3045ccbbadd9a5759b06`
- Canonical-closure subject tree: `fd86b192f25f619a6e3dd5014117e687827db86e`
- Repository observation commit: `aa1170422e76f3cbc75fd83fc69ad369cdb610df`
- Repository observation tree: `df048cdb6a78ee56262e1afb466f8b2b057aa3f9`

## Decision

**FAIL / Needs revision**

| Domain | Current status | Boundary |
| --- | --- | --- |
| Exact PDF/render QA | PASS | only SHA-256 `2392F034...A453822` |
| Current-environment paper A/B | PASS | byte-identical PDF and schema-v3 receipt |
| Complete TeX plus BibTeX input closure | FAIL / not claimed | only all-`pdflatex`-pass `.fls` inputs are closed |
| D14-D16 evidence | PASS, bounded | descriptive accounting only |
| D17/D18-v1 execution | COMPLETE | 85/85 tasks; 8,320/8,320 games |
| D17/D18-v1 canonical integrity | PASS, narrow | authenticated producer plus independent byte match |
| D17/D18-v1 scientific gate | FAIL_CLOSED | 22/45 D18 tasks do not satisfy the diversity criteria |
| D19 | CLOSED | prerequisite scientific gate failed |
| D18-v3 formal evidence | ZERO | no formal receipt ledger or independent verifier |
| BASE-SEARCH formal evidence | NONE ADMITTED | budget preflight is not a formal result |
| Claim-complete tooling | TECHNICAL PASS | subject-bound code; candidate only |
| Scientific sufficiency | FAIL | Reject, 4/10, confidence 4/5 |
| AI-use paper statement | OPEN | author facts and wording unconfirmed |
| Real anonymity coverage | OPEN | complete author identity variants absent |
| Final supplement archive | OPEN | per-file and archive approval absent |
| Fresh clean install | NOT VERIFIED | no clean-environment receipt |
| Live OpenReview form | NOT VERIFIED | no external form inspection or submission |

Canonical integrity is now closed. That removes one artifact-accounting blocker
from v5, but it does not repair the failed scientific gate or change the
independent review recommendation.

## Current manuscript binding

The canonical-closure subject, repository observation, and manuscript build
subject are intentionally distinct. The `b07eb85..aa11704` delta is confined
to five D18-v3 runner, verifier, and test files. The D17/D18-v1 producer and
verifier hashes, paper bytes, and paper inputs did not change. The current
manuscript remains bound by its existing QA receipt:

- build subject commit: `2f4872c05f4d0e264d511255ee5fa4678310d024`;
- build subject tree: `aca5c8e71dbcc16a767ed206b77d595d5c329ab6`;
- `main.pdf`:
  `2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`
  (448,039 bytes; 11 pages);
- `main.tex`:
  `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402`;
- `references.bib`:
  `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659`;
- build receipt A/B:
  `9EDA9A4148C16562C6421F58D7CD0F872F3FADA1362FDEBA8056ABF764E8C6A5`;
- fixed input tree:
  `E53963DFC1996676C369B93E032922E57CC4FEDC72500A90EB27192EE5E194A4`;
- stable output tree:
  `78B3EEACD155D642A886EE3D269D1FE483334DCF3DFB461E66E480EB663240A2`;
- canonical LaTeX runtime tree:
  `8164BC39AD3A0925620DB4CC7302B479EE17EC3A1DD985BABD698F070CD7EE22`.

Both clean builds in the retained environment reproduced the checked-in PDF
exactly. The receipt still leaves BibTeX runtime closure, complete TeX-toolchain
closure, scientific claims, author approval, and submission readiness false.

## Evidence anchors

The following hashes were sampled from the exact files used for this gate.
Repository paths are relative to `research/iclr2027/`. Hash-binding a local
formal artifact does not add it to Git or approve it for a supplement.

| Evidence | SHA-256 |
| --- | --- |
| `results/validation/d17_d18_v1_canonical_closure_receipt_20260901_b07eb85.md` | `DA346F73BAE880DEF896F4E18C285A4E93DC45DD6E9FC76D0B93DAE32DE5CDBC` |
| `paper/ICLR2027_POSTRUN_QA_2392F034.md` | `F743140082A979D5AB43E98FB541D59ACDE4AE12C68CDE575504C83FB545F7CA` |
| `reviews/iclr2027_postrun_independent_review_v5_2392F034.md` | `5A20F9F91735E49FF3512CA589D4CB154D018D59C10D6CE0904EA167AEBB2F22` |
| `paper/CLAIM_EVIDENCE_LIMITATION_V4.md` | `5BE319CE1424ADA24A701418923965DAB47864F2F59CAB4F7ADB1D43C1D6422C` |
| D14-D16 formal receipt ledger | `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114` |
| D14-D16 canonical aggregate | `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C` |
| D14-D16 independent receipt audit | `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648` |
| `configs/d17_d19_formal_manifest.json` | `2349C2B47AC06CD0632F6B06AEA8950A21846F9FFA88320DE4BCC7A49639FFB9` |

## D17/D18-v1 canonical closure

The authenticated producer v2 and independent verifier used these code
bindings:

- producer SHA-256:
  `B65585B023FA6A6A1AD2BBD0CD221637B0B34B60622814251B7928A5C16E0503`;
- producer-test SHA-256:
  `EF2E43BC273513D5FA277F79314FC6972ADB40CB3650933F8E716CBECE514BCE`;
- verifier SHA-256:
  `E6C90F82CBDBEC5FA2116CC642D98C1A09D234B076E55934DF06A4F2A06A9861`;
- exact formal-source digest:
  `21A46DBD787090FC18C24CB4E29EBE1DD743203D31ABEDA43B3CE421833B596C`.

### Producer v2

The producer authenticated and fingerprinted 347 input files under 347 stable
roles. Its before/after input fingerprint was identical:

`1139706DEB7A7E0429F0C81A7DF7AA3E13EA2CC27A2EECF60E8A01396AE7182D`.

It wrote exactly two files:

- canonical numeric SHA-256:
  `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19`;
- derivation receipt SHA-256:
  `C6D800C111AC39DDBFF128AC53BAEA60213FE2CA12503766882A91984F6E7E4E`.

The immutable producer receipt records 85 complete tasks, 8,320 game rows, a
count of 22 of 45 D18 tasks that did not satisfy the task-level diversity
criterion, and `formal_ready=false`. Its
`independent_verification_passed=false` field is the truthful generation-time
state and was not retroactively overwritten.

### Independent v2

The independent verifier wrote exactly two files and no subdirectories:

- independent numeric SHA-256:
  `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19`;
- independent report SHA-256:
  `79DDC3F58C418CB476E1520B1357F74680D811559CFC240F58101131B10604BB`.

The independent numeric file is byte-identical to the producer numeric. The
report independently replays 8,320 records, verifies all 85 tasks, finds zero
truncated games, forms 4,160 paired-color units, and records `issues=[]` and
`failed_tasks=[]`. It observes 4,321 full color-aware trajectories, 4,214 full
sequences ignoring color, and 4,198 continuations ignoring opening and color.

Exactly 24 of 25 verifier gates are true. The only false gate is
`unique_trajectory_thresholds_met`. All three canonical gates are true:
derivation receipt bound, canonical hash verified, and canonical numeric match.

The verifier also reconfirms the producer adapter, producer receipt, producer
input fingerprint, and formal-source digest. Its 337-input snapshot is stable:

- content-set SHA-256:
  `5D51D7E95B2AA4A50CD09E42AC4271EF7E91F5ED09DF042ABE1084112F3EFCC7`;
- complete fingerprint SHA-256:
  `B893045B856F62C949A5B87C57AF58235E9797479D70417C805044D9D27DB720`;
- unchanged after verification: `true`.

The 22 D18 tasks that do not satisfy the diversity criteria are 15/15 at size
5, 5/15 at size 7, and 2/15 at size 9. They roll up to one false bundle-level
gate; they are not 22 verifier gates and are not verifier execution failures.

## Current evidence boundaries

### D14-D16

The formal ledger remains 330/330 complete with compact independent audit and
replay evidence. Each D16 200-game task still contains exactly two deterministic
full-trajectory clusters repeated 100 times. The authoritative status remains
`PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`. No global ranking, topology causality,
sample-efficiency, unseen-size, or independent-game inference is admitted.

### D17/D18-v1 and D19

D17/D18-v1 execution and canonical integrity are complete, but the frozen
scientific gate remains `FAIL_CLOSED` because the trajectory-diversity threshold
fails. `formal_ready=false` is therefore unchanged. D19 remains closed by its
prerequisite gate.

### D18-v3

Current local D18-v3 trees contain preparation artifacts and failed-attempt or
engineering receipts only. Candidate lifecycle records, task bundles, stage
material, and smoke telemetry are not formal experiment results. There is no
formal task receipt ledger or independent formal verification; admitted D18-v3
formal evidence remains **ZERO**.

### BASE-SEARCH

The current CPU budget work is a preflight with warnings, not an admitted
formal result. Candidate budgets did not establish a strict global compute
match, and no author-selected frozen budget/max-plies formal bundle has been
authorized. BASE-SEARCH therefore contributes no scientific result to the
current paper.

## Scientific decision

The exact current PDF remains independently assessed as:

- recommendation: **Reject**;
- score: **4/10**;
- confidence: **4/5**.

The score-driving blockers are unchanged:

1. no decision-relevant topology/history witness in the evaluated benchmark
   distribution;
2. no controlled single-architecture topology/history ablation;
3. trajectory-poor deterministic evaluation and weakly calibrated opponents;
4. an incomplete standalone benchmark and rule contract.

Canonical provenance increases confidence that the recorded outputs faithfully
represent this frozen run. It does not validate scientific inference or supply
the missing effect.

## Remaining submission blockers

### Scientific blockers

1. Produce a replay-verifiable naturally reachable witness, or a rigorous
   larger-board result, where omitted topology/history changes a legal shared
   action, transition, value, or optimal action.
2. Run a prospectively frozen, compute-matched single-architecture ablation
   that toggles logical edges and history independently.
3. Run a diverse paired-opening or stochastic evaluation with a valid
   independent unit, uncertainty, and calibrated stronger opponents or a
   search-budget sweep.
4. Complete the standalone benchmark contract: protected regions,
   attack/cascade rules, automatic skips, Superko canonicalization, scoring,
   and reproduction commands.

Any new D18-v3, D19, BASE-SEARCH, GPU, AutoDL, or paid experiment still requires
an exact manifest, budget, cost, stop policy, and action-time authorization.

### Reproducibility and artifact blockers

1. Run the documented workflow in a genuinely clean environment and persist a
   hash-bound clean-install receipt.
2. Build a new production supplement candidate/archive from the current
   subject-bound tooling only after every payload is reviewed.
3. Verify the final extracted archive against the exact approved subject and
   identity input. Existing candidates are not final archives.

### Author and external blockers

1. Authors complete the AI-use fact inventory and approve the exact paper
   statement. Any insertion changes the PDF and triggers a complete rebuild,
   render QA, and gate refresh.
2. Authors supply the complete private identity-variant list and approve every
   supplement payload, generated control file, and final archive.
3. An author inspects and completes the live OpenReview fields, including the
   separate AI-use answer, then checks consistency with the exact PDF and
   supplement.

## Final gate

- Canonical integrity: **PASS, narrow**.
- Scientific gate: **FAIL_CLOSED**.
- Submission readiness: **NO**.
- Entry to paid extension work: **NO without new authorization**.
- Current PDF technical quality: **PASS for `2392F034...A453822` only**.
- Current-environment reproducibility: **PASS with narrow LaTeX closure only**.
- Scientific recommendation: **Reject, unchanged**.
- External upload or submission performed: **NO**.
