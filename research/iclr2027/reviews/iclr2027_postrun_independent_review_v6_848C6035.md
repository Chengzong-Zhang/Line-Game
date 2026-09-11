# ICLR 2027 independent blind-first review v6

## Review identity and isolation

- Review date: 2026-09-01 (Asia/Shanghai)
- Reviewed artifact: `research/iclr2027/paper/main.pdf`
- PDF SHA-256: `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`
- PDF size/pages: 449,839 bytes / 11 pages
- Blind-first boundary: the review through **Frozen recommendation** below was written after reading and visually inspecting all 11 pages of this PDF and before opening any prior review, submission gate, claim ledger, verifier, receipt, or repository evidence file.
- Scope: scientific peer review of the submitted paper, not an assertion that repository artifacts or release packaging are complete.

## Summary

The paper introduces LIFELINE-RL, a deterministic self-play board-game benchmark in which physical occupancy, player-specific logical connectivity, cascading removal, and Superko history are distinct simulator-state components. It presents three principal forms of evidence: (1) environment tests and Python/Web replay parity, (2) exhaustive side-five state enumeration plus a side-six paired-history Superko witness, and (3) five-seed, mixed-size self-play comparisons among a padded CNN, a physical-edge Grid-GNN, and a typed-logical-edge Topology-GNN.

The paper is unusually careful about claim boundaries. In particular, it states that side-five topology aliases have no legal, transition, value, Q-value, or optimal-action consequence, and that the side-six history pair is equal only under a mask-free Topology projection. Because the implemented observations expose the differing legal mask, the side-six pair is not a same-implemented-observation witness. The empirical model results are also explicitly descriptive: they cover jointly trained sizes, do not yield a global representation ranking, and include heavily duplicated deterministic evaluation trajectories.

## Strengths

1. **Clear simulator-state decomposition.** The separation of rendered occupancy, logical edge sets, repetition history, legal masks, and terminal bookkeeping is technically well motivated and useful for studying representation sufficiency.
2. **Strong negative-result discipline.** Exhaustive side-five enumeration and backward induction are potentially valuable precisely because the result is negative. The authors do not turn latent topology differences into a strategic-sufficiency claim.
3. **Transparent empirical boundaries.** The paper repeatedly distinguishes training seeds from games, ranges from confidence intervals, smoke/pilot conditions from formal results, and artifact completeness from superiority. This substantially reduces the risk of overclaiming.
4. **Substantial auditability on paper.** Exact task counts, game-record counts, search ceilings, model budgets, parameter counts, seed ranges, and known duplication are reported. The benchmark appears designed for replay and receipt-level checking.
5. **Readable presentation.** The paper has a coherent narrative, a useful state schematic, legible tables and figures, and no visible clipping, overlap, broken glyphs, or anonymous-author leakage in the reviewed PDF.

## Major weaknesses

1. **The central construct-validity question remains open.** The paper's most distinctive motivation is that topology and history can matter beyond a grid view. Yet the exhaustive side-five result finds no decision-relevant consequence, while the side-six witness differs in the legal mask and therefore does not alias either implemented mask-bearing observation. This establishes history-dependent legality for a deliberately weakened projection, not that the benchmark's implemented Grid or Topology representation is insufficient.
2. **No causal representation ablation.** Grid-GNN and Topology-GNN differ in relation types and hidden width; the CNN differs more broadly. Parameter matching does not remove architecture, FLOP, memory, transition, or wall-time confounds. TopologyHistory is declared but absent from the neural comparison. Consequently, the experiments cannot identify a benefit from logical edges or compact history.
3. **The positive learning signal is scientifically weak.** Beating Random on seen training sizes is a low bar. Results against UCT-MCTS-16 are heterogeneous, and direct-play tasks repeat only two deterministic color-conditioned trajectories 100 times each. Five seed summaries with no preregistered inferential analysis and very low trajectory diversity do not support a robust performance or representation conclusion.
4. **The history intervention is underpowered and mostly null.** The reported policy pilot triggers Superko only twice, and the preregistered extension fails every practical-similarity gate because of small per-cell sample sizes. A one-game, one-update neural row is a smoke test. These results neither demonstrate a history benefit nor safely establish irrelevance.
5. **The benchmark contribution is narrow relative to ICLR expectations.** The paper studies one hand-designed game, jointly trained sizes only, and a weak search opponent. No unseen-size generalization, cross-game transfer, stronger calibrated opponent, or clean feature-by-feature study demonstrates why this benchmark changes a broader learning conclusion.

## Minor comments and questions

1. What falsifiable learning hypothesis is intended for Topology and TopologyHistory once the implemented legal mask is included?
2. Can the authors construct two reachable states with the same implemented observation and legal mask but different future transition/value/optimal-action consequences, or should the history argument be reframed as a simulator-state and legality-engine contribution only?
3. A same-backbone factorial study crossing logical-edge input and compact-history input would be much more diagnostic than the current three-family comparison.
4. Evaluation should count unique openings/trajectories as the effective support, diversify initial states or policies prospectively, and use a stronger calibrated opponent. Repeated deterministic trajectories should not dominate any performance table.
5. The title foregrounds topology-aware and history-dependent self-play, but the strongest verified findings are environment construction, a side-five negative result, and careful artifact accounting. The framing could be narrowed to match those contributions if stronger experiments cannot be added.

## Score card

- Scientific soundness: **2/4 (fair)**. The claims made in the PDF are generally bounded and internally coherent, but the evidence does not establish the paper's strongest motivating construct.
- Novelty: **2/4 (moderate)**. The particular rule combination and audit framework are novel, while the learning methods and graph architectures are standard and the diagnostic witness is weaker than the implemented observation.
- Empirical evidence: **2/4 (limited)**. Strong for environment bookkeeping and the side-five negative result; insufficient for representation causality, history utility, robust policy strength, or generalization.
- Presentation: **3/4 (good)**. Clear and unusually candid, with minor density and framing issues.
- Reproducibility from the paper alone: **3/4 (good specification, unverified artifacts)**. Protocols and counts are detailed, but repository evidence was intentionally not consulted during this phase.

## Frozen recommendation

**4/10 - Weak Reject. Reviewer confidence: 4/5.**

The work is technically serious and could become a valuable benchmark/resource paper, but the present submission does not yet provide a decision-relevant same-observation/mask witness or a clean same-backbone learned ablation. The positive empirical evidence is too weak and too trajectory-duplicated to compensate. A score change would require either (a) closing that construct-validity gap and testing it causally, or (b) substantially narrowing the contribution and adding a prospectively diversified, compute-accounted evaluation with stronger baselines.

---

The text above is the frozen PDF-only review. Any repository/release audit added below must not revise its score or reasoning retrospectively.

## Post-unblinding repository audit

This section was added only after the PDF-only recommendation had been frozen. It checks whether current local evidence supports the claims already made in the paper and whether the reviewed bytes are ready for release. It does not re-score the paper.

### History-twin evidence

The new append-only evidence materially improves one narrow point relative to the prior v5 review: a naturally reachable paired-history legality witness now exists. The targeted candidate and independent receipt are bound as follows:

| Artifact | SHA-256 | Audit result |
| --- | --- | --- |
| `D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md` | `B4A91DFF91A3B2B94B85CBD8F123B96F57B98C2F435961E01B419229065C9B8D` | Human-readable claim boundary agrees with the receipts |
| `results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | `4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5` | Bounded candidate; 25,000-state/depth-20 limits, PASS included, no time limit; found after 8 states, 69 transitions, depth 6 |
| `results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | `555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F` | `PASS`, `ok=true`, Python/Web replay agreement |
| `results/validation/history_superko_n6_strict_pair_candidate_v1.json` | `5796D643B9F6ED8716983EC3234B2398C7B50D221E2A16EBB9682BA1FB6479F5` | Second candidate instance |
| `results/validation/history_superko_n6_strict_pair_verification_v1.json` | `EF209D84F7906B1858E9954415CD5971AF1F6D2EE878A811BE27EF78B4AD41A1` | Corroborating Python/Web replay PASS |

For the primary pair, both legal histories replay from the standard side-six start to the same board, typed logical edges, current player, consecutive-skip count, and terminal flag. The candidate `(2,3)` is legal only in the twin and is rejected in the reference exactly as `SUPERKO_VIOLATION`; no other legal placement differs. The target projection hash is `33EAB73543D4521C09423D9D97E5129E02C18401049463273182161DC2DD8577`, and the candidate-result key is `C1362C7A100C1C512E2345740F4D9CBD1C34C12B7AB708D65DAC681365C14608`.

The persisted evidence and current code were resampled with 30 targeted/D6 tests. A restricted sandbox run produced three temporary-directory permission errors and 27 passes; the same suite under normal Windows project permissions passed **30/30**. Ruff lint and format checks passed for the three new Python files.

This closes only the existence of a natural mask-free-topology history-legality pair. It does **not** close the score-driving construct-validity blocker: the legal masks differ, so the implemented Grid and Topology observations are not equal. The receipts make no exact-value, optimal-action, unavoidable-regret, learning-effect, TopologyHistory-superiority, or same-backbone-ablation claim. The older v5 review sentence that no natural pair existed is superseded in this narrow respect; its demand for an identical implemented observation/mask with a future decision consequence remains unsatisfied.

### Existing empirical evidence

The D14-D16 anchors resample to their prior hashes: the 330-receipt ledger is `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`, the canonical aggregate is `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`, and the independent receipt audit is `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648`. The seed/pair audit remains `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`. This supports the paper's bounded counts and summaries, not a global ranking or causal feature effect.

D17/D18-v1 canonical integrity remains a narrow technical pass, while the frozen scientific gate remains failed because 22/45 D18 tasks miss the trajectory-diversity criterion; D19 remains closed. The tracked D18-v3 manifests still state `frozen_zero_formal_games`; the empirical capacity JSON is capacity planning only and is not a formal result. No later run repairs the paper's representation or evaluation blockers.

### PDF and release audit

- The append-only technical receipt `paper/ICLR2027_POSTRUN_QA_848C6035.md` is 8,385 bytes with SHA-256 `F578DCEC09657ED4FBA7CC0E7554F7800130FE456EB6FE6793E09D49654BE89C`; it records a technical/visual PASS only for the exact PDF bytes. Its inspected 11-page render set and contact sheet were removed after QA.
- Current source binding: `main.tex` SHA-256 `FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21`; `references.bib` remains `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659`.
- The exact 11-page PDF was visually inspected in full. The current log has no undefined citation/reference, overfull box, rerun request, or LaTeX/BibTeX error; seven underfull diagnostics are non-blocking in the inspected rendering.
- Structural inspection finds `/Names` with only `/Dests`, no `/EmbeddedFiles`, `/EF`, Filespec, JavaScript, AcroForm, Widget, FileAttachment, alternate action, or encryption. `/OpenAction` is only a page-one `/GoTo /Fit`. All 24 fonts are embedded/subset/Unicode; all 76 links use hidden borders.
- Metadata is anonymous but not literally empty: Author, Title, Subject, and Keywords are empty, while Creator, Producer, `PTEX.Fullbanner`, and UTC date fields remain. There is no XMP stream.
- The current PDF and new witness files are working-tree changes on branch `codex/territory-v2-page-correctness` at HEAD `db469b380812e5b254c61b55682679700f5fc65d`; they are not a clean committed subject.
- A 129-row v2 supplement profile and allowlist now name the five new evidence files, but both are untracked and explicitly `candidate_only_not_approved`. The existing per-file author-review sheet still binds the older 120-payload/124-member topology and keeps every decision open. No current production candidate, final archive, complete identity review, or author approval is established.

### Post-unblinding disposition

Repository evidence increases confidence that the side-six mechanism claim and bounded D14-D16 accounting are faithfully recorded. It does not establish equal implemented observations, a learned benefit, a same-backbone ablation, diverse evaluation, stronger opponent calibration, or unseen-size generalization. Therefore the frozen recommendation remains **4/10 - Weak Reject, confidence 4/5**.

Technical PDF quality is a **PASS for the exact `848C6035...A99F6` bytes**. Scientific readiness and submission readiness remain **FAIL / needs revision**. No commit, stage, push, upload, submission, network access, package installation, GPU run, or paid compute was performed by this review.
