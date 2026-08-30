# ICLR 2027 AI-use disclosure audit and draft

> **Status: P0 OPEN — author confirmation is required.**
>
> This is an internal evidence audit and wording draft. It is not the mandatory
> section in `main.tex`, and it is not the OpenReview submission-form
> disclosure. Creating this file does not close P0-A. P0 remains open until the
> authors confirm the facts, add the final statement to the paper, complete the
> separate submission-form disclosure, and rerun the submission gate.

Audit date: **2026-08-30**

Repository: `C:\coding\py\line game`

Audit-start snapshot:

- branch `codex/d17-d19-p0`;
- HEAD `bd66575f865d5b4bfbdeffc3ca7eea94b24a4f8c`; and
- gate-frozen candidate PDF SHA-256
  `00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E`.

Historical live re-sample at **2026-08-30T01:17:55+08:00** after concurrent workspace
activity:

- branch `main`, at the same HEAD;
- then-current `main.pdf` SHA-256
  `A955C1E9B29B8FE98398680D83DDE0F52E63A68263EDEA8CEA18FFAC84453466`;
- then-current PDF length: 11 pages; and
- neither sampled `main.tex` nor extracted PDF text contained an AI-use
  statement.

The branch switch and paper/template rebuild happened concurrently outside
this audit. This audit did not perform either action and does not infer who did.
The existing submission gate is bound to the older PDF hash, so it must be
rerun on the live candidate after the disclosure is confirmed and inserted.

Latest local refresh at **2026-08-31**:

- candidate `main.pdf` SHA-256
  `AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`;
- candidate length: 11 pages;
- the AB99 QA receipt passes, while
  `submission_gate_postrun_v3_20260831_ab99ec04.md` returns `FAIL`; and
- neither current `main.tex` nor extracted AB99 PDF text contains an AI-use
  statement. P0-A therefore remains **OPEN**.

This audit uses “AI assistance” to mean generative-AI/LLM assistance in the
research and writing workflow. It does **not** mean the Minimax, MCTS, or neural
game-playing opponents studied by the paper.

## 1. Official ICLR 2027 requirements

### 1.1 Sources checked

| Official source | URL | Accessed | Verified requirement |
| --- | --- | --- | --- |
| ICLR 2027 Author Guidelines | <https://iclr.cc/Conferences/2027/AuthorGuidelines> | 2026-08-30 | The guidelines contain a heading, “Required: AI use statement,” and say that this section does not count toward the page limit. |
| ICLR 2027 AI Policy for Authors | <https://iclr.cc/Conferences/2027/AIPolicyForAuthors> | 2026-08-30 | Authors must explicitly state how they used LLMs both in the paper text and in the paper submission form. The paper disclosure is a mandatory section and does not count toward the page limit. Authors remain responsible for the submission. |
| Official ICLR 2027 LaTeX template linked by the Author Guidelines | <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip> | 2026-08-30 | The template uses `\subsection*{AI use statement}`, repeats that the section is required and outside the page limit, and says it should not exceed one page. |
| ICLR 2027 OpenReview conference entry | <https://openreview.net/group?id=ICLR.cc/2027/Conference> | 2026-08-30 | This is the submission-system URL linked by the Author Guidelines. It returned HTTP 403 during this audit, so the exact live form questions, choices, and required-field markers were not independently captured. |

The AI Policy states, in relevant part:

> “We ask that authors explicitly state how they used LLMs in their
> submission, both in the paper’s text as well as in the paper submission
> form.”

It also states that the form will solicit “some” of the listed information,
requires a mandatory paper section, and says the template wording is an example
rather than a required exact format. The policy says a substantial
LLM-produced falsehood, plagiarism, or misrepresentation **would be considered**
a Code of Ethics violation by the authors and **might lead** to desk rejection.

### 1.2 Mandatory paper section versus submission-form disclosure

**Mandatory section in the paper**

- Every submission must contain an AI-use statement in the paper text.
- The section does not count toward the page limit.
- The official template says the statement should not exceed one page and uses
  the heading `\subsection*{AI use statement}`.
- The statement must accurately cover AI uses for ICLR’s required-disclosure
  tasks. The official boilerplate suggests explicitly identifying other
  required tasks as “not used” or “not applicable,” but the policy says authors
  need not follow that exact format.
- ICLR recommends disclosing the recommended-disclosure tasks. Independently,
  this project’s no-hiding requirement chooses to include every actual use;
  that stronger choice is not presented as an extra ICLR mandate.
- The final wording should identify the work performed and the authors’
  validation, without inventing tool versions or verification that did not
  occur.

**Separate disclosure in the submission form**

- The form disclosure is additional to, not a replacement for, the paper
  section.
- The paper statement likewise does not replace the form disclosure.
- The public policy says that the form will solicit “some” of the information,
  but the exact 2027 form schema was not accessible in this audit.
- At submission time, an author must inspect every live form field and ensure
  that the answers are consistent with the final paper statement.

### 1.3 ICLR task classification

The policy lists these tasks as **required to disclose** when AI was used:

- generating synthetic data;
- developing theoretical models or conceptual frameworks;
- formulating mathematical claims or providing critical ingredients for them;
- assisting with proofs;
- proposing or refining hypotheses;
- designing or giving feedback on research methodology or experiments;
- implementing methods;
- translating;
- cleaning or reformatting datasets;
- supporting qualitative or thematic analysis; and
- interpreting results.

The policy lists these tasks as **recommended to disclose** when AI was used:

- formulating questions for surveys or interviews;
- creating or modifying scientific figures or images;
- suggesting experimental parameters;
- creating or editing software code or other artifacts;
- drafting paper text;
- transcribing recordings of research material;
- summarizing or analysing literature;
- discovering topics or gaps, brainstorming, or sourcing information;
- editing a paper for readability;
- identifying literature or formatting references; and
- suggesting paper structure, title, or keywords.

Important boundary: “implement methods” is required, while general software
code creation/editing is recommended. If AI-assisted code contributed to the
method evaluated in this paper, it must be treated as a required-disclosure
use. Likewise, claim-boundary editing must be treated as required if it
formulated claims, refined hypotheses, changed methodology, or interpreted
results; it is only ordinary recommended editing if it changed wording without
substantive scientific input.

## 2. Evidence inventory

### 2.1 Repository-verified facts

"Verified" below means only that the stated record or artifact exists in the
working tree and that its cited content was inspected. Except for the
separately identified current-session observation, record existence does not
independently prove that the described generative-AI activity occurred, that
its output entered this paper, which tool/model was used, or which human
performed a check.

| ID | Verified fact | Evidence and boundary |
| --- | --- | --- |
| V1 | The paper-revision handoff asserts AI assistance in literature-metadata triage, figure generation from verified artifacts, claim-boundary editing, and LaTeX/PDF QA. | `research/iclr2027/paper/PAPER_HANDOFF.md:119-123`. This is a paper-specific self-report, not independent provenance. The underlying uses, tools, models, outputs, and authors’ acceptance still require confirmation. |
| V2 | A tracked project-level AI-coding summary states that AI tools were used for solution discussion, code implementation, debugging, documentation organization, and theoretical analysis. It also states that the author supplied rules, tested and corrected outputs, and decided the final architecture. | `core algorithm/AI/AI_CODING_SUMMARY.md:3-17`. This is a project-level self-report, not a tool-by-tool mapping to research-used code or the manuscript. |
| V3 | A tracked development plan contains prompts intended to have AI create early Minimax/Alpha-Beta and Pygame integration code. | `core algorithm/AI/minimax_ai_plan.md:86-218,259-518`; the separate self-report of human corrections is at `core algorithm/AI/AI_CODING_SUMMARY.md:11-17`. Prompt existence does not prove that an output was retained, used by this paper, or generated by a particular model/version. |
| V4 | The literature audit records checks of 30 bibliography records against Crossref, DataCite, or DBLP fields. | `research/iclr2027/paper/LITERATURE_METADATA_AUDIT.md:3-5,7-40`. This corroborates a validation procedure; it does not establish AI provenance, identify every checker, or show that AI searched for or interpreted literature. |
| V5 | Three paper figures are reproducibly generated by Python from frozen JSON/CSV artifacts, and their source, denominator, encoding, and limitation contracts are documented. | `research/iclr2027/paper/PAPER_HANDOFF.md:68-80`; `research/iclr2027/paper/FIGURE_CONTRACTS.md:3-45`; `research/iclr2027/paper/figures/build_figures.py:118-228`. These facts corroborate programmatic generation and source-bound QA, not AI provenance or an exact division of AI and human work. |
| V6 | A frozen claim/evidence/limitation ledger records permitted claims and prohibited short forms; the handoff records claim-boundary rewrites. | `research/iclr2027/paper/CLAIM_EVIDENCE_LIMITATION.md:1-28`; `research/iclr2027/paper/PAPER_HANDOFF.md:96-106`. This corroborates claim checking but does not establish AI provenance or show whether AI merely edited wording or contributed substantive interpretation. |
| V7 | The handoff records LaTeX/BibTeX stabilization, full-page rendering/inspection, and anonymity checks for hash-bound candidates, including the latest AB99 QA chain. | `research/iclr2027/paper/PAPER_HANDOFF.md:107-111,131-146,239-244`. These records corroborate historical QA steps, not AI provenance, author acceptance, or the identity of every checker. |
| V8 | The current gate explicitly marks the missing paper section and form decision as P0-A and requires human-author confirmation. | `research/iclr2027/submission_checks/submission_gate_postrun_v3_20260831_ab99ec04.md`. The AB99 gate returns `FAIL`, and this draft does not satisfy its closing conditions. |
| V9 | Committed records state that two formal-runner attempts were hosted in Codex unified-exec sessions and that receipt checks preceded the documented recovery sequence. | `research/iclr2027/D14_D16_RESULTS.md:187-198`; `research/iclr2027/results/formal/d14_d16/runner_control_v1/RECOVERY_INCIDENT.md:17-44`. This proves process-hosting and recovery-sequence provenance only. Whether generative AI selected commands, monitored the runs, or performed recovery is not established. |
| V10 | Current workflow documents use the labels `AI-2` for experiment/aggregation work and `AI-3` for independent simulated review, and record recomputation against raw artifacts. | `research/iclr2027/reviews/experiment_audit_round1.md:19-29,200-209,529-531`; `research/iclr2027/reviews/iclr_mock_review_round1.md:1-5`; `research/iclr2027/reviews/iclr_mock_review_round2.md:1-5`; `research/iclr2027/submission_checks/submission_gate.md:1-6`. These internal labels are not proof of generative-AI participation, tool identity, model identity, or influence on the paper. |

At the 2026-08-30 audit snapshot, V1, V4-V8, and V10 relied partly on
then-untracked working-tree documents; later tracking them changes neither
their evidentiary limits nor the need for author confirmation. V2-V3 and V9
were already tracked project-history records. Neither status justifies
guessing exact tool versions or paper-specific attribution.

**Current-session observation (not repository-verified provenance):** this
audit and disclosure draft were prepared with a generative-AI coding assistant.
The exact deployed model/version and account context are not established and
must not be invented. If wording from this file enters the paper or form, that
is AI-assisted paper drafting and should be included in the final disclosure.

### 2.2 Facts that the authors must confirm

1. **Tools and models.** Confirm every product, provider, model name/version,
   and whether model routing changed across sessions. Project-level files
   mention the product families Claude Code, Codex, and Gemini, but they do not
   establish which of them contributed to this paper. Exact model versions in
   broad project credits are intentionally omitted from this draft.
2. **Research stage.** Confirm whether AI participated in ideation, theory,
   hypothesis formation, method/experiment design, implementation, parameter
   selection, data processing, result interpretation, writing, translation,
   or rebuttal preparation.
3. **Generated or modified content.** Identify the specific research-used code,
   tests, configs, manuscript passages, bibliography entries, figure scripts or
   images, tables, captions, and QA reports that AI generated or modified.
4. **Method implementation.** Determine which AI-assisted code, if any, is part
   of the methods evaluated in the paper. This determines whether the use is
   required rather than merely recommended disclosure.
5. **Claim-boundary role.** Confirm whether AI only edited phrasing or also
   formulated claims, refined hypotheses, designed methodology, or interpreted
   results. Pending confirmation, this must be handled conservatively as a
   potentially required-disclosure use.
6. **Human verification.** Name the author(s) who reviewed each retained output
   and confirm which tests, registry checks, artifact comparisons, independent
   recomputations, citation checks, or page-by-page inspections they personally
   completed.
7. **Unpublished-material transmission.** For each external AI service, confirm
   whether any non-public manuscript, code, data, formal result, figure, log,
   prompt, or supplementary package was uploaded or pasted.
8. **Negative and not-applicable declarations.** For every ICLR required task,
   confirm “AI used,” “AI not used,” or “not applicable.” Absence of a repository
   record is not evidence of non-use.
9. **Co-author use.** Confirm whether any co-author used additional tools or
   models outside this repository history.
10. **Experiment and review workflow.** Confirm the role of AI in runner
    orchestration/recovery, protocol or preflight feedback, aggregation, and
    simulated review, and whether any such output changed methods, analysis,
    claims, or manuscript text.
11. **Final consistency and responsibility.** All authors must approve the
    paper statement, the live submission-form answers, and the final
    responsibility language.

### 2.3 Matters that must not be inferred from the repository

- Exact model or version from a branch name, commit author, product credit,
  process label, timestamp, or file-writing tool.
- Account identity, subscription, organization, prompts, chat history, privacy
  configuration, training opt-out, or data-retention setting.
- Whether unpublished material was transmitted to an external AI service.
- Which exact paper paragraph or code file came from which model, or whether an
  AI output was retained verbatim.
- A percentage of AI contribution or an implication that AI was an author.
- Non-use of a required ICLR task merely because no log was found.
- A model from the labels `AI-1`, `AI-2`, or `AI-3`; those are workflow roles.
- Paper-writing or scientific-conclusion generation from the phrase “Codex
  unified exec”; that phrase records process hosting, not content provenance.
- The final OpenReview field names, required markers, choices, or answers. They
  were not visible during this audit.

## 3. Provisional policy mapping for this paper

| Activity | Current evidence | ICLR handling | Draft decision |
| --- | --- | --- | --- |
| Research-used method implementation | A project-level self-report and development prompts describe code assistance; paper-specific use is unresolved. | **Required** if AI implemented methods; otherwise general code editing is recommended. | Author must identify research-used files and classify the work; do not infer inclusion. |
| General code creation, editing, and debugging | Project-level self-report/prompts exist; prompt retention and paper relevance are unresolved. | Recommended. | Disclose only the author-confirmed paper-relevant subset. |
| Literature-metadata triage and reference formatting | The untracked handoff asserts AI use; the registry audit corroborates the metadata work, not AI provenance. | Recommended. | Retain only after author confirmation; do not upgrade it to literature discovery or interpretation. |
| Scientific figure generation from frozen artifacts | The untracked handoff asserts AI use; code and artifacts corroborate programmatic figure generation, not AI provenance. | Recommended. | Retain only after author confirmation and include source/regeneration checks actually performed. |
| Claim-boundary editing | The untracked handoff asserts AI use; claim-ledger artifacts corroborate the editing task, not its AI provenance or substantive role. | Required if it affected claims/hypotheses/methods/result interpretation; otherwise recommended editing. | Retain only after confirmation and treat as potentially required until the author narrows it. |
| LaTeX/PDF QA | The untracked handoff asserts AI use; build/QA records corroborate tasks performed, not AI provenance or human verification. | Recommended paper/artifact editing. | Retain only after author confirmation, with checks authors actually performed. |
| Drafting this disclosure | Directly observed in the present session. | Recommended paper drafting if incorporated. | Include if any wording is adopted. |
| Theory, experiment design, parameter selection, or result interpretation | A broad project self-report mentions theoretical analysis and solution discussion; paper-specific use is unresolved. | Required when AI was used. | Each author must answer explicitly; no negative statement may be inferred. |
| Experiment orchestration, monitoring, and recovery | Records prove Codex-hosted runner attempts and a recovery sequence only; generative-AI involvement is unresolved. | Not separately named in the list; disclose if authors confirm generative-AI workflow assistance. | Do not state AI involvement until confirmed, and never imply that AI generated or chose results. |
| Protocol/preflight/aggregation and simulated review | Internal `AI-2`/`AI-3` role labels exist; they do not prove generative-AI participation or influence. | Required if confirmed AI work provided methodology feedback or result interpretation; otherwise recommended artifact/paper review. | Author must first confirm that AI was involved, then the actual tasks, outputs, and influence. |

## 4. Draft A — concise mandatory paper section

**Do not paste this into `main.tex` until every bracketed item has been resolved
and all authors have approved it.**

> **AI Use Statement.** Generative AI assistance in this work comprised
> **[AUTHOR INSERT every confirmed required-disclosure task]** and
> **[AUTHOR INSERT every confirmed recommended-disclosure task]**. Candidate
> uses requiring author confirmation are AI-assisted project software
> discussion, implementation/editing and debugging, documentation, and theory
> work, plus manuscript-stage literature-metadata triage, programmatic figure
> preparation from frozen verified artifacts, claim-boundary editing, and
> LaTeX/PDF quality assurance; **[RETAIN EACH ITEM ONLY IF THE AUTHORS CONFIRM
> THAT IT CONTRIBUTED TO THIS PAPER]**. A generative-AI assistant was used to
> prepare this disclosure audit and draft; include that use if any wording from
> the draft is adopted. Records also show two runner attempts hosted in Codex
> unified-exec sessions and internal `AI-2`/`AI-3` role labels, but those facts
> do not establish generative-AI work; **[ADD ANY WORKFLOW USE ONLY AFTER
> CONFIRMING THE ACTUAL AI TASKS AND THEIR INFLUENCE]**. For all other required
> tasks, **[AUTHOR USE THE OFFICIAL BOILERPLATE OR AN EQUIVALENT ACCURATE
> ACCOUNT OF “NOT USED” AND “NOT APPLICABLE” TASKS]**. The authors reviewed all
> retained AI-assisted outputs using **[AUTHOR CONFIRM only code tests,
> source/citation checks, artifact regeneration, claim-ledger checks, and
> LaTeX/PDF inspection actually completed by authors]**. The authors take full
> responsibility for the final text, claims, code, figures, references, and
> other artifacts in this submission.

## 5. Draft B — detailed submission-form disclosure

Because the exact live 2027 form fields were unavailable, this is a detailed
prose draft to adapt field by field at submission time. Tool/model/version,
unpublished-material, and data-handling prompts below are internal author
due-diligence items requested for this audit; the public policy does not prove
that all are mandatory OpenReview fields. Include them in the form only as the
live fields permit or request, while keeping the form consistent with Draft A.

> Generative AI assistants **[AUTHOR INSERT each confirmed product, provider,
> and model/version; use “unknown” rather than guessing]** were used for
> **[AUTHOR LIST only confirmed paper-relevant tasks and stages]**. Candidate
> scopes to confirm are: project software discussion, implementation/editing,
> debugging, documentation, and theory work; and manuscript literature-metadata
> triage, programmatic figure preparation from frozen artifacts,
> claim-boundary editing, and LaTeX/PDF quality assurance. A generative-AI
> coding assistant also inspected repository evidence and drafted this
> disclosure; include that use if its wording is retained. The repository also
> records Codex-hosted runner attempts and uses internal `AI-2`/`AI-3` labels,
> but neither fact proves generative-AI participation; **[AUTHOR ADD workflow,
> protocol/preflight/aggregation, or simulated-review uses only after confirming
> the actual AI tasks, outputs, and influence]**. For ICLR’s required tasks,
> **[AUTHOR RECORD AI USED / AI NOT USED / NOT APPLICABLE for generating
> synthetic data; theoretical models or conceptual frameworks; mathematical
> claims, critical proof ingredients, or proofs; hypotheses; methodology or
> experiment design/feedback; method implementation; translation; data
> cleaning/reformatting; qualitative or thematic analysis; and result
> interpretation]**. Retained AI-produced or AI-modified outputs comprised
> **[AUTHOR LIST exact code, prose, references, figures, tables, captions, and
> artifacts]**. The authors verified them through **[AUTHOR CONFIRM only checks
> personally completed: rule/specification review; unit, replay, headless,
> browser, or integration tests; Crossref/DataCite/DBLP metadata checks;
> regeneration from frozen JSON/CSV artifacts; claim-to-evidence-to-limitation
> review; citation/reference checks; and LaTeX builds plus page-by-page PDF
> inspection]**. **[AUTHOR RECORD internally, and disclose where the live form
> requests or permits, whether each service received unpublished manuscript
> text, source code, data, results, figures, logs, prompts, or supplements and
> which data-handling controls were actually known; never infer “no” from
> missing logs.]** No AI-generated output was accepted without author review
> **[AUTHOR CONFIRM]**. All authors take full responsibility for the
> correctness, originality, attribution, and policy compliance of the final
> submission, including all AI-assisted content.

## 6. Author confirmation area — complete every item

### A. Tools and models

- [ ] For every AI-assisted stage, record the product/provider and exact model
  or version if known; mark genuinely unknown versions as “unknown.”
- [ ] Confirm or reject each project-level candidate tool family (Claude Code,
  Codex, and Gemini) for **this paper**, without importing unconfirmed model
  versions from the project credits.
- [ ] Record the generative-AI assistant used for this audit/disclosure draft
  and confirm its model/version only if independently known.
- [ ] Ask every co-author to report any additional AI tool use not represented
  in the repository.

### B. Stages and generated content

- [ ] Synthetic-data generation and dataset cleaning/reformatting: for each,
  record used / not used / not applicable and identify outputs.
- [ ] Theoretical models/conceptual frameworks; mathematical claims, critical
  proof ingredients, or proofs; and hypotheses: for each, record used / not
  used / not applicable and identify outputs.
- [ ] Methodology or experiment design/feedback and method implementation: for
  each, record used / not used / not applicable; identify exact research-used
  files and separate method implementation from general code editing.
- [ ] Translation, qualitative/thematic analysis, and result interpretation:
  for each, record used / not used / not applicable and identify outputs.
- [ ] General code creation/editing/debugging, parameter suggestions, and other
  artifact creation: identify the paper-relevant subset and retained outputs.
- [ ] Experiment hosting/orchestration/monitoring/recovery,
  protocol/preflight/aggregation, and simulated review: first confirm whether
  generative AI was actually involved, then identify tasks, outputs, human
  checks, and any effect on methods, results, claims, or text.
- [ ] Survey/interview-question formulation and research-material
  transcription: record used / not used / not applicable and identify outputs.
- [ ] Literature discovery/analysis versus metadata triage/reference
  formatting: separate these roles and identify the affected records.
- [ ] Figures, tables, captions, manuscript drafting/revision, and LaTeX/PDF
  QA: identify what AI generated or modified and what was retained.
- [ ] Brainstorming, information sourcing, research-topic/gap discovery,
  readability edits, relevant-literature identification, and suggested paper
  structure/title/keywords: record the confirmed paper-relevant uses.
- [ ] Confirm whether wording from this AI-assisted disclosure draft will be
  incorporated into the paper or submission form.

### C. Human verification

- [ ] Name the author(s) who reviewed each retained AI-assisted output.
- [ ] Confirm the exact code tests and rule/specification checks performed by
  authors; do not rely only on an AI report that tests passed.
- [ ] Confirm bibliography metadata and citation-context checks, including
  plagiarism/originality review where relevant.
- [ ] Confirm that each retained figure/table was regenerated or checked
  against its frozen source artifacts, denominators, labels, and limitations.
- [ ] Confirm every retained claim against the frozen
  claim/evidence/limitation ledger and source artifact.
- [ ] Confirm the final LaTeX build, citation/reference status, anonymity,
  metadata, and page-by-page PDF inspection.

### D. Unpublished material, accounts, and privacy

- [ ] For each external AI service, answer whether any non-public manuscript,
  code, data, formal results, figures, logs, prompts, or supplement were
  uploaded or pasted.
- [ ] If “yes,” record what was sent, to which service, by whom, for what
  purpose, and what access/retention/training controls were actually known.
- [ ] If the answer or setting is unknown, state “unknown”; do not reconstruct
  account, subscription, privacy, or retention details from repository files.
- [ ] Remove all account identifiers, secrets, private prompts, and unnecessary
  personal information from the disclosure.

### E. Final paper and form responsibility

- [ ] Resolve every bracket in Draft A and Draft B without hiding, weakening,
  or inventing AI use.
- [ ] Insert the approved mandatory section into the official ICLR 2027 paper
  source using the template’s unnumbered AI-use-statement heading, keep it at
  no more than one page, and rebuild the candidate. This draft file alone is
  insufficient.
- [ ] Complete the live OpenReview submission-form disclosure separately and
  compare it line by line with the paper statement.
- [ ] Obtain approval from all authors for the factual inventory, validation
  claims, unpublished-material statement, and final responsibility statement.
- [ ] Rerun the submission gate on the new paper/PDF and record the new hash.
- [ ] Keep P0-A marked **OPEN** until every item above is complete and the gate
  passes. **Current P0-A status: OPEN.**
