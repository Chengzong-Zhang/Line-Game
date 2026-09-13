# LIFELINE-RL post-run submission gate v7

- Gate date: 2026-09-01 (Asia/Shanghai)
- Exact manuscript PDF: `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`
- Repository observation HEAD: `db469b380812e5b254c61b55682679700f5fc65d`
- Repository observation tree: `9b8424cc30ae59f9802a0f3e14ffba104daee0da`
- Branch: `codex/territory-v2-page-correctness`
- Subject boundary: the paper, new evidence, review, and gate are working-tree bytes. The working tree is not clean, and this gate does not claim a committed or release-approved subject.

## Decision

**FAIL / Needs revision. Submission readiness: NO.**

| Domain | Current status | Exact boundary |
| --- | --- | --- |
| PDF technical and visual QA | **PASS** | exact `848C6035...FFA99F6` bytes only |
| Same-environment deterministic rebuild | **PASS, narrow** | fixed environment reproduced identical PDF bytes; not a clean install or independent runtime |
| Natural side-six history-twin mechanism | **PASS, narrow** | equal mask-free topology; one Superko legal-set difference |
| Same implemented observation and mask | **FAIL / OPEN** | legal masks differ; the witness is exposed by the implemented interface |
| Future value/optimal-decision consequence | **NOT ESTABLISHED** | no exact-value, optimal-action, regret, or policy-necessity result |
| Same-backbone logical-edge x compact-history ablation | **ABSENT** | no formal result; no learning-effect claim admitted |
| D14-D16 evidence | **PASS, bounded** | descriptive accounting only; no global ranking or inference |
| D17/D18-v1 scientific gate | **FAIL_CLOSED** | execution/integrity complete, but 22/45 D18 diversity criteria fail |
| D19 | **CLOSED / no result** | prerequisite scientific gate failed |
| D18-v3 | **ZERO formal games** | tracked manifests remain `frozen_zero_formal_games`; capacity evidence is planning only |
| Supplement v2 topology | **CANDIDATE ONLY** | 129-row untracked profile/allowlist; not author-reviewed, built, archived, or approved |
| Fresh clean install | **NOT VERIFIED** | no new clean-environment execution receipt |
| AI-use disclosure | **OPEN** | author facts and exact paper/form wording unconfirmed; statement absent from PDF |
| Identity/anonymity approval | **OPEN** | complete private identity variants and per-file author review absent |
| Final archive | **OPEN** | no subject-bound approved archive or independent verify-extract receipt |
| Live OpenReview form | **NOT VERIFIED** | no external form inspection, upload, or submission |
| Scientific assessment | **Weak Reject** | 4/10, confidence 4/5 |

The new witness repairs the older statement that no natural paired-history legality witness had been found. It does not repair the score-driving construct-validity or experimental-design blockers, so it does not change the submission decision.

## Exact current-paper chain

| Artifact | Bytes | SHA-256 | Disposition |
| --- | ---: | --- | --- |
| `paper/main.pdf` | 449,839 | `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6` | Exact 11-page manuscript |
| `paper/main.tex` | 33,017 | `FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21` | Current source |
| `paper/references.bib` | 11,152 | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` | Bibliography input |
| `paper/ICLR2027_POSTRUN_QA_848C6035.md` | 8,385 | `F578DCEC09657ED4FBA7CC0E7554F7800130FE456EB6FE6793E09D49654BE89C` | Technical/visual PASS only; inspection images removed after QA |
| `reviews/iclr2027_postrun_independent_review_v6_848C6035.md` | 14,760 | `9672F9A680D17D6688BF1CF6847BD7C73AD7488E24D6BC6D72B92319E4455EAD` | Blind-first 4/10 Weak Reject; repository audit added only after score freeze |
| `paper/CLAIM_EVIDENCE_LIMITATION_V6.md` | 13,515 | `EF5E7714CF223C8D94DF6B5F7257D6F1B31BD26D4E8B3799AE85A1138D4BD034` | Current claim routing and limitations |

The v6 claim ledger was written before the fresh review and gate existed, so its statement that the current review was pending is historically correct at that cutoff. The review and this v7 gate now provide the missing current-PDF bindings; they do not change its scientific or author/release limitations.

## Technical PDF and build status

The exact PDF passes the current append-only QA receipt:

- 11 US-Letter pages, no clipping, overlap, missing figure, unreadable glyph, broken table, visible link border, or accidental blank page;
- all 24 font resources embedded, subset, and Unicode-mapped;
- no encryption, AcroForm, Widget, FileAttachment, JavaScript, Filespec, `/EF`, or `/EmbeddedFiles`;
- Catalog `/Names` contains exactly `/Dests`; `/OpenAction` is a benign page-one `/GoTo /Fit`, not a script;
- 76 link annotations, all with hidden borders;
- anonymous identity fields are empty, but metadata is not absent: Creator, Producer, `PTEX.Fullbanner`, and UTC dates remain;
- the retained LaTeX/BibTeX logs have no undefined citation/reference, rerun request, overfull box, BibTeX warning, LaTeX error, emergency stop, or fatal error;
- the fixed `pdflatex -> bibtex -> pdflatex x3` sequence and one additional fixed-environment pass reproduced identical PDF bytes.

This is a technical PASS, not full reproducibility. The build occurred in the retained working environment and dirty worktree. It does not establish a clean committed checkout, a fresh install, complete TeX-plus-BibTeX runtime-input closure, or independent toolchain reproduction.

## Side-six history-twin evidence

### Bound artifacts

| Evidence | SHA-256 | Role |
| --- | --- | --- |
| `D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md` | `B4A91DFF91A3B2B94B85CBD8F123B96F57B98C2F435961E01B419229065C9B8D` | Append-only claim/boundary note |
| `results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | `4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5` | Bounded candidate search |
| `results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | `555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F` | Python plus Web replay PASS |
| `results/validation/history_superko_n6_strict_pair_candidate_v1.json` | `5796D643B9F6ED8716983EC3234B2398C7B50D221E2A16EBB9682BA1FB6479F5` | Second natural candidate |
| `results/validation/history_superko_n6_strict_pair_verification_v1.json` | `EF209D84F7906B1858E9954415CD5971AF1F6D2EE878A811BE27EF78B4AD41A1` | Corroborating replay PASS |

The primary targeted witness is:

```text
Reference = [(0,1),(4,0),(2,0),(1,4),(2,3),
             (2,2),(3,1),(1,4),PASS,(1,1)]
Twin      = [(2,0),(1,4),(0,1),(1,1),PASS,(4,0)]
Candidate = (2,3)
```

Both histories are legal from the standard side-six start and end with BLACK to act. Board values, both typed logical-edge sets, current player, consecutive skips, and terminal flag are identical. The target projection SHA-256 is `33EAB73543D4521C09423D9D97E5129E02C18401049463273182161DC2DD8577`. The candidate-result key SHA-256 is `C1362C7A100C1C512E2345740F4D9CBD1C34C12B7AB708D65DAC681365C14608`.

`(2,3)` succeeds in the twin and is rejected in the reference exactly with `SUPERKO_VIOLATION`; all other legal placements agree. The deterministic target-prioritized search included PASS, had a 25,000-state/depth-20 ceiling and no wall-clock stop, and found the candidate after 8 states, 69 transitions, and depth 6. These counts are not a prevalence, shortest-path, or exhaustive-search claim.

The persisted Python/Web receipts are `PASS` with `ok=true` and `cross_engine_replay_verified=true`. Current resampling under normal Windows project permissions passes 30/30 targeted/D6 tests; Ruff lint and format checks pass for the three new Python files. Earlier restricted-sandbox errors were only temporary-directory permission failures and are not counted as code failures.

### Mandatory scientific boundary

The supported statement is only:

> Naturally reachable side-six histories can have identical mask-free topology but different Superko legality for a shared placement.

The legal masks differ. Therefore the witness does not provide equal implemented Grid or Topology observations, a same-observation-and-mask future-correct-decision pair, different exact values or optimal actions, a learning benefit, TopologyHistory necessity/superiority, or a same-backbone ablation result. The central construct-validity blocker remains **OPEN**.

## Existing empirical evidence

### D14-D16

The principal anchors are unchanged:

- 330-receipt ledger: `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`;
- canonical aggregate: `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`;
- independent receipt audit: `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648`;
- seed/pair descriptive audit: `E8DBB1CBAFC15DE0C7B2879CA3697E8F21F3F8C6D84354715B75A5F4D078C7CD`, status `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`.

These artifacts support the paper's bounded task/game counts and five-seed descriptive summaries. They do not support independent-game inference, a global representation ranking, causal logical-edge/history benefit, relative sample efficiency, or unseen-size generalization. Every deterministic D16 200-game task still contains only two color-conditioned trajectories repeated 100 times.

### Later experiments

D17/D18-v1 execution and canonical integrity are complete, but the frozen scientific gate remains `FAIL_CLOSED`: 22/45 D18 tasks miss the trajectory-diversity criterion and `formal_ready=false`. D19 therefore remains closed.

The tracked D18-v3 manifests remain `frozen_zero_formal_games`. The capacity receipt resamples historical game lengths for planning and explicitly does not certify a future run. Preparation, smoke, recovery, or candidate files are not formal experiment evidence. BASE-SEARCH preflight likewise remains planning evidence, not an admitted paper result. Any future GPU, AutoDL, paid, D18-v3, D19, or BASE-SEARCH execution requires a separately frozen exact manifest, budget, cost, stop policy, and fresh action-time authorization.

## Supplement and author/release status

The local v2 profile and allowlist now contain 129 payload rows and include the five history-twin evidence files:

- `supplement_tools/claim_complete_profile_v2.json`: SHA-256 `FD4F4590F966315E4428C42173E460E1A8002D0C50264B108F13406B7F94277E`;
- `supplement_tools/supplement_claim_complete_allowlist_v2.json`: SHA-256 `3DEA2A327E42CF02A8C808BE28DE1CB9F092FBF370CDC7C453543A695E4A35CE`.

Both are untracked working-tree files and explicitly `candidate_only_not_approved`; `require_git_tracked=false` in the allowlist is not a release approval. The existing author per-file review sheet still binds the older 120-payload/124-member topology and keeps all decisions open. No v2 production candidate, subject-bound archive, complete identity scan, author-approved per-file sheet, archive approval, or independent verify-extract receipt exists. Historical candidates and archives must not be silently reused.

The paper also lacks an author-confirmed AI-use statement. Complete private author identity variants, exact disclosure wording, final paper/supplement bytes, and the live OpenReview form remain author-owned gates. Nothing in this technical workflow supplies those facts or approvals.

## Scientific decision

The current PDF was reviewed blind-first before old reviews, gates, claim ledgers, or repository evidence were opened. The frozen assessment is:

- recommendation: **Weak Reject**;
- score: **4/10**;
- confidence: **4/5**.

Repository unblinding confirms that the narrow history-legality mechanism is real and honestly bounded in the paper. The score remains unchanged because the following score-driving blockers remain:

1. no same-implemented-observation-and-mask future decision witness;
2. no prospectively frozen same-backbone `logical edges x compact history` ablation;
3. trajectory-poor deterministic evaluation with a weakly calibrated UCT-MCTS-16 opponent;
4. no valid inferential unit, diverse opening distribution, strong search sweep, or unseen-size result;
5. incomplete clean-install, standalone rule-contract, supplement, author, and live-form closure.

## Required closure before submission

### Scientific

1. Either close the same-observation/mask future-decision question with replay-verifiable evidence or narrow the paper's positioning so it no longer relies on that construct.
2. Freeze and execute a single-backbone factorial ablation toggling logical edges and compact history independently, with credible compute accounting and no architecture confound.
3. Prospectively diversify openings/trajectories, define the independent unit and uncertainty analysis, and evaluate against calibrated stronger opponents or a search-budget sweep.
4. Complete the standalone rule and benchmark contract, including protected regions, attack/cascade behavior, automatic skips, Superko canonicalization, scoring, and exact reproduction commands.

### Reproducibility and release

1. Bind the exact paper and evidence to a reviewed clean Git subject without discarding unrelated user changes.
2. Run the documented workflow in a genuinely fresh clean environment and retain a public-safe hash-bound reproduction receipt.
3. Freeze and verify the 129-row v2 supplement topology, then build one exact subject-bound production candidate and archive.
4. Obtain complete private identity coverage, per-file author decisions, final archive approval, and independent verify-extract evidence.

### Author and external

1. Authors complete the AI-use fact inventory and approve the exact paper and OpenReview disclosure wording; any paper-byte change requires a fresh build, QA, review binding, and gate.
2. Authors approve the exact paper/supplement bytes and complete the live OpenReview metadata and form.
3. Only after all preceding gates pass may an upload or submission be authorized.

## Final gate

- Exact PDF technical/visual quality: **PASS for `848C6035...FFA99F6` only**.
- Natural mask-free history-legality witness: **PASS, narrow**.
- Same implemented observation/mask decision witness: **OPEN / NOT ESTABLISHED**.
- Same-backbone learned ablation: **ABSENT**.
- Scientific sufficiency: **FAIL**.
- Independent recommendation: **Weak Reject, 4/10, confidence 4/5**.
- Supplement/release readiness: **NO**.
- Author approval: **NO / not recorded**.
- Submission readiness: **NO**.
- External upload or submission performed: **NO**.
- Commit, stage, push, network access, package installation, training, GPU work, or paid compute performed by this gate: **NO**.
