# Independent ICLR 2027 Review v4 - blind-first freeze

## Review status and immutable blind-first decision

- Review date: 2026-08-31 (Asia/Shanghai)
- Blind-first freeze time: 2026-08-31T03:23:18+08:00
- Manuscript: `research/iclr2027/paper/main.pdf`
- PDF SHA-256: `69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C`
- PDF size: 448,051 bytes
- PDF pages: 11, letter size, unencrypted, no forms or JavaScript
- Frozen overall recommendation: **Reject**
- Frozen overall score: **4/10**
- Frozen confidence: **4/5**

The recommendation, score, confidence, and scientific issues in Sections 2-8 were frozen after reading and visually checking the current PDF, but before opening `main.tex`, formal receipts, audit outputs, policy materials, any pre-existing review, or any submission-gate report. Later artifact checks may change confidence in whether a PDF claim is correctly bound to repository evidence; they do not retroactively change this independent scientific score. No existing file under `research/iclr2027/reviews/` and no `submission_gate_postrun*.md` file was read to form this judgment.

## 1. Blind-first review method and PDF QA

I recomputed the manuscript hash, obtained its PDF metadata with Poppler, rendered all 11 pages to PNG, inspected pages 1 through 11 individually at original rendered resolution, and extracted the PDF text for content review. The render contained exactly 11 non-empty page images.

Technical and visual QA result: **PASS with minor presentation issues**.

- No clipped text, overlapping blocks, missing glyphs, black boxes, broken figures, or unreadable tables were observed.
- The title page is anonymous and the PDF metadata fields for title, author, subject, and keywords are blank.
- Page headers, line numbers, page numbers, equations, references, tables, and figures render consistently.
- Figure 1 is legible and conveys the latent-edge witness. Figures 2 and 3 and Tables 1-5 are readable at normal review zoom.
- Minor issues: the heavily justified captions around monospaced artifact names on pages 6-7 have awkward spacing; Figure 2 uses a truncated vertical range, although its caption clearly discloses that choice; page 11 contains substantial unused space. These are not decision-driving.

This QA pass addresses only the PDF as rendered. It is not evidence that the scientific claims are sufficient or that the supplement is reproducible and policy-compliant.

## 2. Summary of the paper

The paper introduces LIFELINE-RL, a deterministic two-player self-play benchmark with a triangular lattice, player-specific logical connectivity, cascading removals, and a Superko-style history-dependent repetition rule. It distinguishes full simulator state, masked Grid observations, topology-aware observations, and a history-augmented variant. The paper reports exhaustive side-five analysis, a side-six Superko-triggering trace, and bounded larger-board searches. It then compares a padded CNN, a physical-edge Grid-GNN, and a typed-logical-edge Topology-GNN using a small AlphaZero-style pipeline on jointly trained board sizes 5, 7, and 9.

The empirical message is deliberately conservative. All 45 final seed scores beat Random on seen sizes, performance against UCT-MCTS-16 varies across model and size, and deterministic round-robin evaluation produces only two unique color-conditioned trajectories per 200-game task. The paper explicitly declines to claim a global representation ranking, unseen-size transfer, relative sample efficiency, or inferential significance.

## 3. Strengths

1. **Unusually clear claim boundaries.** The manuscript repeatedly separates exhaustive results, computational witnesses, budgeted misses, pilots, smoke conditions, descriptive summaries, and formal artifacts. This substantially reduces the risk of overclaiming.
2. **A technically interesting state-design problem.** Separating rendered occupancy, player-specific logical edges, and repetition history is a useful benchmark-design idea. The full-state and observation definitions expose a real representation question that ordinary fixed-board occupancy benchmarks often hide.
3. **Strong internal accounting on the face of the PDF.** The paper reports exact state and transition counts, task and receipt counts, replay-record counts, seeds, search budgets, model sizes, and known exclusions. It also identifies deterministic trajectory duplication rather than treating 1,000 repeated games as independent observations.
4. **Good negative-result discipline.** The exhaustive side-five result is presented as a negative result at side five, not generalized to larger boards. The failed larger-board paired-witness search is labeled a budgeted miss. The Superko pilot and preregistered extension are not promoted beyond their gates.
5. **Readable and compact presentation.** The core definitions, model equation, protocol, results, limitations, and reproducibility statement fit into a coherent 11-page artifact with clear tables and figures.

## 4. Major scientific weaknesses

### P0-1: The central decision-relevant topology/history motivation is not empirically established

The benchmark is advertised around topology-aware and history-dependent self-play, but the strongest complete analysis cuts against a decision-relevance claim: at side five, every reachable Grid-equivalent pair agrees in legal actions, one-step Grid observations, exact value, shared-action values, and optimal actions. The side-six Superko trace shows that the rule can bind, but it is not the paired-state witness needed to show that the implemented observation variants create a decision-relevant ambiguity. The bounded larger-board search did not find such a witness.

Consequently, the paper demonstrates latent-state aliasing and an active repetition rule, but does not yet demonstrate that topology or history inputs resolve a strategically meaningful ambiguity for the learning problem studied. This is a central scientific gap, not a wording issue.

### P0-2: The neural experiments do not causally test the claimed structural factors

The comparison changes both representation and architecture. Grid-GNN and Topology-GNN have different widths and relation types; the padded CNN is a different model family. FLOPs, memory, transitions, evaluation compute, and wall time are not matched. More importantly, the declared `TopologyHistory` observation is not included, and there is no controlled logical-edge removal or history-feature ablation in the formal neural comparison.

The reported heterogeneous outcomes therefore cannot identify the effect of topology information, history information, or architectural inductive bias. Parameter-count matching within 0.6982% is useful but insufficient for the paper's motivating representation question.

### P0-3: Evaluation effective sample size and opponent strength are too weak for an ICLR-level representation conclusion

There are five training seeds per cell, but each 200-game deterministic round-robin task repeats only two unique color-conditioned trajectories 100 times. The manuscript correctly treats the results as descriptive, yet that honesty leaves very little evidence about robustness. The final comparison uses Random and a 16-simulation UCT-MCTS opponent; beating Random is a low bar, and UCT-MCTS-16 is not established as a stable, calibrated measure of policy strength across sizes.

There is no prospectively designed paired-opening or stochastic evaluation with adequate trajectory diversity, no uncertainty interval at the true independent unit, no formal paired comparison, and no multiplicity-aware analysis. As a result, the empirical section validates execution and bookkeeping more strongly than it validates a scientific conclusion about learned representations.

### P1-1: The environment is under-specified as a standalone benchmark paper

Key mechanics such as the three-point restriction, protected-region behavior, exact attack/cascade rules, automatic skips, canonical-position construction for Superko, and territory scoring are described only at a high level. A reader cannot independently reimplement the environment from the PDF. A benchmark contribution normally needs either a complete formal rule specification in the paper/supplement or a stable anonymous executable package that makes the semantics and version binding unambiguous.

### P1-2: Breadth and external validity are limited

All learned results are on jointly trained sizes 5, 7, and 9 in one hand-designed game. There is no held-out-size evaluation, cross-game evidence, or test that targets states where logical topology or repetition history is actually decision-relevant. The paper acknowledges these limits, but they still constrain novelty and impact.

### P1-3: Training and baseline coverage are too small to characterize a benchmark

Each seed uses 100 self-play games, 200 updates, and 16 PUCT simulations. The broader Random/Greedy/Minimax/UCT matrix is described as an engineering smoke test rather than a formal result. No stronger search-budget sweep, expert baseline, oracle analysis beyond side five, or learning-curve protocol supports a claim that the benchmark meaningfully separates methods.

## 5. Minor weaknesses and presentation questions

### P2 items

- Clarify whether the Web implementation was independently written from a separate rule specification or shares logic/tests with the Python engine; "independent" is otherwise ambiguous.
- Give the full manifest digest in the paper or anonymous supplement rather than the abbreviated `1bbf2c9a9ecc...` form.
- Report evaluation compute and per-model transition counts, and explain why different training wall times are scientifically acceptable for the intended comparison.
- Explain why the root Dirichlet parameter `alpha = 0.3` is appropriate across action spaces that change substantially with board size.
- State how mixed-size self-play games are allocated across sizes within each 100-game run.
- Report draw rates and terminal-length distributions in a reader-facing table, not only in an artifact audit.
- Explain what would constitute a successful benchmark result if no representation ranking is expected; currently the benchmark's discriminative target is not crisp.
- The phrasing "pre-registered" should be accompanied by a prospectively timestamped, immutable protocol artifact accessible to reviewers.

## 6. Questions for the authors

1. Can you provide a naturally reachable pair of histories with the same implemented non-history observation but different optimal decisions, legal shared action, or transition consequence? If not, what concrete learning-relevant property requires topology/history input in the formal tasks?
2. Can you run a controlled model family in which node features, depth, width, optimizer, parameter count, FLOPs, and evaluation protocol are fixed while only logical-edge and history channels are toggled?
3. Can you replace repeated deterministic games with a prospectively frozen paired-opening/stochastic protocol whose independent unit and uncertainty analysis are valid?
4. How does UCT-MCTS performance change at substantially larger search budgets, and do representation conclusions remain stable against a stronger or calibrated opponent?
5. Is the complete environment specification and anonymous runnable package sufficient to reproduce every rule, table, and computational proposition without access to private checkpoints or local task trees?

## 7. ICLR-style scoring

- Overall recommendation: **Reject**
- Overall score: **4/10** - technically careful and potentially useful, but the current evidence does not yet support the central scientific motivation or a representation-level conclusion.
- Confidence: **4/5** - the paper is clear about what it did and did not establish; remaining uncertainty concerns artifact verification rather than interpretation of the PDF.
- Technical quality / soundness: **2/4** - the reported computations are carefully bounded, but the central causal and decision-relevance questions remain untested.
- Presentation: **3/4** - clear, disciplined, and readable, with only minor layout issues and some rule under-specification.
- Significance / contribution: **2/4** - the environment idea is interesting, but one game, seen-size evaluation, weak opponents, and non-discriminative formal evidence limit impact.
- Originality: **3/4** - the combination of topology, cascades, and repetition-sensitive self-play is distinctive, though related graph-game and state-aliasing work reduces conceptual novelty.
- Ethics flag: **No apparent issue from the PDF.**

## 8. Minimum work that would change the recommendation

A cosmetic revision, more repeated deterministic games, or additional artifact bookkeeping would not change the score. The minimum outcome-changing package is:

1. **Decision-relevance closure:** produce a replay-verifiable, naturally reachable witness (or a rigorous larger-board result) showing that omitting logical topology or history changes a legal shared action, transition, value, or optimal action in the actual benchmark distribution.
2. **Controlled causal ablation:** prospectively freeze and run one architecture with topology edges and history features toggled independently, while matching compute sufficiently to isolate those inputs.
3. **Diverse evaluation:** use frozen paired openings or another protocol that yields genuinely diverse trajectories, treats the seed/opening as the independent unit, reports uncertainty, and evaluates against calibrated stronger opponents or a search-budget sweep.
4. **Reproducible benchmark contract:** provide a complete rule specification plus an anonymous, verifier-backed package containing the compact data and scripts needed to reproduce the computational propositions and all paper tables from public inputs.

If items 1-3 produced a consistent effect with valid uncertainty and item 4 passed independently, I would reconsider toward borderline accept. Merely showing that all methods beat Random, adding more trajectory repetitions, or documenting current receipts more extensively would not be enough.

## 9. Post-freeze artifact and policy audit

This audit was performed after the recommendation and scientific issues above were frozen. It verifies whether the current repository evidence supports the manuscript's bounded claims and whether the candidate is procedurally ready. It does not convert artifact completeness into scientific sufficiency.

### 9.1 Exact source, PDF, and QA-receipt binding

| Artifact | Current SHA-256 | Result |
| --- | --- | --- |
| `research/iclr2027/paper/main.pdf` | `69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C` | Exact reviewed PDF; 11 pages |
| `research/iclr2027/paper/main.tex` | `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402` | Matches the source hash recorded by the QA receipt |
| `research/iclr2027/paper/references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` | Matches the QA receipt |
| `research/iclr2027/paper/ICLR2027_POSTRUN_QA_69247087.md` | `ED15A39F05F8DD71A101E0AA1EC8C7B1F464601B1D18E5B0C9B7A2BF6E93A7E3` | Exact post-run QA receipt reviewed after score freeze |
| `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.json` | `E8DBB1CBAFC15DE0C7B2879CA3697E8F21F3F8C6D84354715B75A5F4D078C7CD` | Matches the QA receipt; JSON inspected post-freeze |
| `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.md` | `73AAB2C79C19402651170939C11819CBAF69A76D59AF0D33AB82C9EC2202188F` | Hash matches the QA receipt; its prose was not opened for the blind review |
| `research/iclr2027/D14_D16_TERMINOLOGY_ERRATUM.md` | `275B303903A89C3C7697BC76A4E7D59E93325B281334CD9F6072DFD14FDDAF3E` | Matches the QA receipt |
| D14-D16 `result_receipts.jsonl` | `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114` | Matches the QA receipt and receipt-status JSON |
| D14-D16 `aggregate.json` | `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C` | Matches the QA receipt and both independent audits |

All eight content hashes recorded inside the QA receipt were recomputed from the current files and matched. The receipt itself is explicitly scoped to PDF/technical QA and explicitly leaves scientific, AI-use, supplement, and live-form gates open. At the initial repository preflight it was an untracked working-tree file; that does not invalidate its byte binding, but it means repository/release governance is not closed.

The local ICLR 2027 style archive is SHA-256 `0D940DFA9398AE99A18F24A85A8A683F367204B6AF6D17D2899E60A67102529E`, matching the archive digest written in `main.tex`.

### 9.2 Formal receipt and independent-audit findings

Formal artifact integrity result: **PASS for the limited D14-D16 execution/accounting claims**.

- `execution_summary.json` (SHA-256 `69A732E929AA1D8799D7472FEFD02810B66AA70F5E628338AAC7EEBF34337D98`) reports experiment `d14_d16_three_representation_formal_v1`, 330 complete receipts, zero failed receipts, zero missing receipts, and `formal_ready=true`.
- `result_ledger_status.json` (SHA-256 `4FAFEF3E26D3A8D8B544EF6A40D8A8A21E73EFB6177B748F3F44E777D2D7D898`) binds the same manifest digest `1bbf2c9a9ecc9174cd2d4b4299e22289dea58b7a53885e1be923374add2841cb`, the current ledger digest, one execution identity, and `valid=true`.
- The seed/pair descriptive audit JSON has status `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`. It reconstructs 15 training and 315 evaluation receipts, 30,600 evaluation records, 15,300 color-swapped pairs, 45 D16 tasks, and 72 purpose-group rows; all 72 canonical comparisons match. Its limitations explicitly deny significance, global ranking, a causal representation effect, sample efficiency, and unseen-size generalization.
- Every one of the audit JSON's nine named source hashes was checked against the current repository and matched, including the manifest, four aggregate views, two task JSONL files, receipt ledger, and audit script.
- `d14_d16_independent_receipt_audit_20260831.json` (SHA-256 `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648`) reports `ok=true`, 1,065 artifact-hash checks with zero mismatches, 330 complete receipts with no duplicate/missing/extra task, 72/72 aggregate rows with zero numerical mismatch, and an independent replay sample of two games from each of 315 evaluation tasks (630 games) with no failure.
- That same audit directly confirms the key effective-sample-size problem: each of the 45 round-robin tasks has exactly two full-trajectory clusters, each cluster repeated 100 times.

One artifact-interface caveat is worth retaining. The immutable task-bundle summary still says `tasks_generated_not_run`, because it is a pre-execution task-definition artifact. Current completion is established by the later result ledger and execution summary. The anonymous package should keep this precedence obvious so that reviewers do not mistake a frozen pre-run status for current execution state.

These checks support the manuscript's execution counts, bounded descriptive tables, and receipt integrity. They do **not** close the score-driving weaknesses: no decision-relevant topology/history witness, no controlled topology/history ablation, and no statistically adequate diverse evaluation.

### 9.3 Reproducibility assessment

Reproducibility result: **strong accounting, incomplete end-to-end reproduction**.

- The current source, manifest, aggregate views, task definitions, compact receipt projection, code, tests, and verifier outputs are extensively hash-bound.
- The paper correctly states that checkpoints, raw per-game logs, and local task directories are not submission artifacts.
- The independent audit reads all receipt-bound records and replays a 630-game sample, but the anonymous candidate cannot reproduce the exact learned checkpoints or independently replay all 30,600 records from checkpoint bytes because those bytes and raw execution trees are deliberately excluded.
- The claim-complete candidate includes a dependency lock and environment receipt, but its own README says that no clean-install execution is claimed for the exact candidate bytes.
- The rules remain too terse in the PDF alone; practical reproduction depends on the anonymous code package. Until that package is final and clean-install verified, the standalone benchmark contract is incomplete.

This is materially better than an unsupported manuscript, but it is evidence preservation and verification rather than a complete independent reproduction of training and evaluation.

### 9.4 Anonymous supplement status

The newest local claim-complete candidate inspected was:

`local_artifacts/claim_complete_candidate_rootcheck_20260831/`

Its manifest and privacy bindings are:

- `SHA256_MANIFEST.json`: `5B9912E5C9F86B0D09EF7F4A69D9B419D9F38876566F26FC7B5A587F6904DA28`
- `PRIVACY_SCAN.json`: `90C35EE1E7DDADB2EE9D789D02E6CB5620543A417F5E9EA0A6142FF652F6A837`
- allowlist digest: `ffefede858fa92e53ac39c46d2bfa97ff03e039f4bc91bfd30e7ca28e97f103c`
- manifest status: `candidate_only_not_approved`

I independently rehashed all 117 declared payload files. There were zero hash/size mismatches, zero missing entries, and zero extra payload entries. The directory contains 119 files when the self-excluded manifest and privacy report are counted. A targeted scan for known local author/name/student-ID/username/path variants found no hit, and no forbidden archive, PDF, checkpoint, key, environment, or database extension was present.

Nevertheless this is **not a final anonymous supplement**:

1. The manifest and README require author approval.
2. The recorded privacy scan used only one configured identity term. A complete author-supplied list of names, student IDs, usernames, affiliations, hosts, and variants has not been demonstrated by these bytes.
3. No clean-install execution is claimed for the exact candidate tree.
4. It is a local candidate directory, not an author-approved final archive with a fresh hash-bound submission gate.
5. It deliberately excludes checkpoints, raw trajectories, and execution trees, so its replay claims remain bounded.

The older narrow `candidate_build_06` ZIP is still present at SHA-256 `C359A925E670D724682870B38AE57EC0E96A76249D020AFA806949088A816432`. Its 18 manifest payloads/20 ZIP entries rehashed without mismatch, but its own manifest says `candidate_only_author_approval_required`; it is not a substitute for the newer claim-complete tree.

Anonymous-supplement disposition: **P0 submission/release blocker, independent of the 4/10 scientific score**.

### 9.5 AI-use disclosure and live submission form

AI-use policy result: **P0 OPEN**.

The exact local official-template archive contains `\subsection*{AI use statement}` and labels it required, outside the page limit, and no more than one page. A source scan of the current `main.tex` found no AI-use heading or disclosure (`rg` exit 1). The current PDF likewise contains no such section.

The available internal materials do not close this gap:

- `AI_USE_DISCLOSURE_DRAFT.md` SHA-256: `F3B66308C32EC94DCB4DB163129EB3D1BF167DEEE407A5134D44A6674B5CDBCE`
- `AI_USE_AUTHOR_DECISION_PACKET.md` SHA-256: `65AE01ABE14708455BD8EE74DC88B8BA1A4B6BAE09D730F2659CB922D2F910AF`

Both state that author confirmation is required and that the files are neither the mandatory paper section nor the submission-form disclosure. The decision matrix remains unresolved. Exact tools/models, paper-relevant tasks, substantive method/claim involvement, unpublished-material transmission, human verification, co-author use, and final responsibility wording must not be inferred from repository silence.

The live OpenReview form was not accessed in this review: network access was prohibited, and the exact live fields/required markers therefore remain unverified. The form answer is a separate author action and cannot be replaced by the paper section or a local draft.

Required closure sequence:

1. Authors complete and approve the factual AI-use inventory.
2. Insert the approved statement into `main.tex`, rebuild, and treat the new PDF as a new artifact with a new hash.
3. Repeat complete PDF QA and an independent hash-bound review on that new PDF.
4. An author inspects and completes the actual live submission-form fields, then checks consistency with the paper statement.

AI-use paper disclosure and Live form disposition: **two separate P0 submission blockers, neither score-driving**.

### 9.6 Final separation of outcomes

| Dimension | Disposition | Meaning |
| --- | --- | --- |
| PDF/render/technical QA | **PASS** for SHA-256 `69247087...D73B88C` | 11/11 pages legible; fonts embedded/subset; metadata anonymous; no embedded files |
| Formal D14-D16 accounting | **PASS, bounded** | Receipt/task/hash/count claims reconcile; descriptive-only limitations remain |
| Scientific sufficiency | **FAIL for acceptance threshold** | Frozen Reject, 4/10, confidence 4/5 |
| Reproducibility | **PARTIAL** | Strong compact evidence and code candidate; no final clean-install, checkpoints, or full raw replay package |
| AI-use statement in paper | **P0 OPEN** | Required section absent; author facts unresolved |
| Anonymous supplement | **P0 OPEN** | Byte integrity passes, but candidate is not approved/final and identity/clean-install gates remain |
| Live submission form | **P0 OPEN / unverified** | No network check or author completion performed |

The post-freeze evidence increases confidence that the manuscript accurately reports its narrowly worded D14-D16 accounting. It does not change the scientific recommendation.

## 10. Verification commands and scope receipt

Representative commands run from the repository root:

```powershell
git status --short --branch
git branch --show-current
git remote -v

Get-FileHash -Algorithm SHA256 -LiteralPath .\research\iclr2027\paper\main.pdf
Get-FileHash -Algorithm SHA256 -LiteralPath .\research\iclr2027\paper\main.tex
Get-FileHash -Algorithm SHA256 -LiteralPath .\research\iclr2027\paper\ICLR2027_POSTRUN_QA_69247087.md

pdfinfo .\research\iclr2027\paper\main.pdf
pdftoppm -png .\research\iclr2027\paper\main.pdf .\tmp\pdfs\iclr2027_v4_69247087_20260831\page
pdftotext -layout .\research\iclr2027\paper\main.pdf .\tmp\pdfs\iclr2027_v4_69247087_20260831\main.txt
pdffonts .\research\iclr2027\paper\main.pdf
pdfdetach -list .\research\iclr2027\paper\main.pdf

rg -n -i "\\subsection\*\{AI use statement\}|AI[- ]use statement|generative AI|large language model|\bLLM\b" .\research\iclr2027\paper\main.tex
```

The 11 rendered PNGs were opened and inspected individually at original rendered resolution. `pdffonts` reported every listed font as embedded and subset; `pdfdetach` reported zero embedded files. MiKTeX emitted a non-fatal `log4cxx` user-log permission warning for some Poppler commands, but the commands returned complete outputs and the expected files.

For artifact verification, JSON files were parsed with `ConvertFrom-Json`; every source named by the seed/pair audit was rehashed and compared to its recorded digest. The claim-complete candidate's 117 manifest entries were independently rehashed and checked for exact path, size, missing, and extra-file equality. The older ZIP was opened read-only with `.NET System.IO.Compression`, and all 18 manifest payload hashes were checked in-stream.

Scope receipt:

- No pre-existing review Markdown was opened to form or revise the scientific judgment. The formal seed/pair audit Markdown was hash-checked only; its JSON was inspected after the score freeze.
- No `submission_gate_postrun*.md` file was opened.
- No paper, experiment result, supplement candidate, source, protocol, or frozen receipt was modified.
- The only durable repository change made by this review is this new review report. The rendered pages and extracted text were temporary QA intermediates under `tmp/pdfs/` and were removed after verification.
- No network access, training, paid compute, submission, upload, commit, push, or publication action was performed.
