# ICLR 2027 migration QA receipt

QA date: 2026-08-30 (Asia/Shanghai)  
Repository HEAD: `bd66575f865d5b4bfbdeffc3ca7eea94b24a4f8c`  
Branch observed at final QA: `main`  
Commit/push performed: no/no

## Frozen input and review scope

- Required input baseline PDF SHA-256:
  `00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E`.
- Applicable review inputs:
  `../reviews/iclr_mock_review_round2.md` and
  `../submission_checks/submission_gate.md`.
- Explicitly excluded review state: the seven-page
  `BAD6AF30...4F967` candidate and its page/layout conclusions.

## Official template provenance

- Author Guidelines:
  <https://iclr.cc/Conferences/2027/AuthorGuidelines>
- Official archive:
  <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip>
- `iclr-2027-style-files.zip` SHA-256:
  `0D940DFA9398AE99A18F24A85A8A683F367204B6AF6D17D2899E60A67102529E`.
- `iclr2027_conference.sty` SHA-256:
  `797DEEF41724E93761426AC0CBCCA46279A91CC650DD1F0CE76A4F08D2098EA6`.
- `iclr2027_conference.bst` SHA-256:
  `2D67552DB7ED38CCFCCB5957B52F95656E25C249724761D3CF5F7922AD1844C5`.

The vendored style/BST are byte-identical to the official archive and were not
edited. Source inspection confirms `main.tex` uses
`iclr2027_conference`, contains no manual `\lhead`, and does not enable
`\iclrfinalcopy`. The rendered 2027 review header, anonymous author block,
line numbers, and page geometry come from the official style.

## Final artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| `main.pdf` | `3000054C0A1BDE8158AA0EBCF6E24AFB54DB15B2DB3AA3109B6D5E1FA6C9A981` |
| `main.tex` | `BBDCD2E9B63A5AA5288CB14403372A4AEE744668F4E2C527759562C5D9988F05` |
| `references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| `figures/build_figures.py` | `C08FE66F4E239FD7D7F071E68E37DBF7720CCB37BB951E7EAEF6A0C6F5F04916` |
| `figures/fig1_lifeline_logical_edges.pdf` | `995E9816CE894C731283F676184C55368F1AF004A120E04F834F320F569A62F9` |
| `figures/fig2_checkpoint_curves.pdf` | `749450AF83A43FD9EF76D8C634EC5916B332ABC473E8AEBE176EEA361CE7B330` |
| `figures/fig3_model_size_opponent_heatmap.pdf` | `97D13851D69D354E899930B5B6FFBB060582C74F59CD6B82D099F814D244A09E` |
| `iclr-2027-style-files.zip` | `0D940DFA9398AE99A18F24A85A8A683F367204B6AF6D17D2899E60A67102529E` |
| `iclr2027_conference.sty` | `797DEEF41724E93761426AC0CBCCA46279A91CC650DD1F0CE76A4F08D2098EA6` |
| `iclr2027_conference.bst` | `2D67552DB7ED38CCFCCB5957B52F95656E25C249724761D3CF5F7922AD1844C5` |

## Build receipt

`latexmk` did not complete on this Windows host because its Perl/runtime
mapping was unavailable. The stable fallback was:

```powershell
Set-Location 'C:\coding\py\line game\research\iclr2027\paper'
pdflatex -interaction=nonstopmode -halt-on-error main.tex
bibtex main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

Observed result:

- all five commands exit 0;
- output: 11 pages, 444,095 bytes;
- stable `main.log`: no undefined citation/reference, rerun request,
  overfull box, LaTeX error, emergency stop, or fatal error;
- `main.blg`: no BibTeX warning/error;
- only underfull box diagnostics remain;
- MiKTeX could not write its global diagnostic log under the user profile, but
  the compiler and BibTeX both exited 0 and wrote the complete local build
  artifacts.

## Bibliography and content checks

- bibliography entries: 30;
- unique cited keys: 30;
- missing keys: 0;
- uncited entries: 0;
- tables: 5;
- figures: 3;
- paper figures: vector PDF with embedded Times New Roman; PNG inspection
  copies remain reproducible from the same script;
- body typography: official Times family with T1 encoding;
- bibliography URL typography: surrounding Times-family text;
- forbidden `30,600 unique games` forms: 0;
- required `30,600 task-indexed replay-verified game records` wording:
  present in all claim-bearing locations;
- source references to `iclr2026_conference`: 0;
- manual `\lhead`: 0;
- AI-use statement in `main.tex`: 0, pending author confirmation;
- D17/D18/D19 result text in `main.tex`: 0.

The related-work section includes the requested closest neighbors: Ludii,
Regular Boardgames, Polygames, Hex board-size and game-variant transfer,
graph-based chess RL, and GNN-based Hex. Their registry audit is in
`LITERATURE_METADATA_AUDIT.md`.

## Scientific evidence gate

Only accepted D14--D16 evidence is used. The candidate retains:

- external validity limited to one hand-designed game;
- representation/architecture confounding, including the different typed
  relations and hidden widths of Grid-GNN and Topology-GNN;
- two unique color-conditioned trajectories per D16 200-game task;
- unmatched FLOPs, memory, transitions, wall time, and incomplete evaluation
  compute accounting.

`../D17_D19_RESULTS.md` is absent. The readable v5 status reports 10/85
complete tasks, 640/8,320 verified games, 75 missing tasks,
`formal_ready=false`, and
`independent_verification_passed=false`. No partial performance,
generalization, confidence interval, significance, D16-v2, or
matched-architecture conclusion was imported.

## Release and AI-policy gate

The requested `supplement/RELEASE_CLAIM_DELTA.md` was not found in the
repository. The manuscript release inventory was narrowed using the applicable
submission gate: it names compact aggregate CSV/JSON, receipt-ledger JSONL,
protocol/config hashes, and independent verifier outputs, and explicitly does
not claim submission of checkpoints, raw game logs, or local task directories.

No anonymous supplement archive was created or validated, so supplement P0-3
remains open.

`AI_USE_DISCLOSURE_DRAFT.md` is a confirmation worksheet only. The authors
have not confirmed the factual inventory or wording. Therefore no AI-use
statement was inserted into the paper and AI-policy P0-2 remains open.

## PDF structural QA

Poppler `pdfinfo`, `pdffonts`, `pdftotext`, and `pypdf` checks report:

- pages: 11;
- page size on every page: 612 x 792 pt, US Letter;
- rotation: 0;
- encryption: none;
- forms/JavaScript: none;
- fonts: every `pdffonts` entry is embedded and subset, including Times New
  Roman text inside all three vector figures;
- PDF author metadata: empty;
- PDF title metadata: empty;
- visible author block: `Anonymous authors` and double-blind review text;
- link annotations: 75;
- annotations with visible borders: 0;
- identity/path scan hits for author name, local username/path, repository-owner
  URL, and email patterns: 0.

## Page-by-page visual QA

The final PDF was rendered with Poppler at 144 dpi and all 11 pages were
inspected, including full-resolution checks of the two figure-dense pages and
the final appendix page.

| Pages | Content | Result |
| --- | --- | --- |
| 1--2 | Title, abstract, introduction, related work, environment start | PASS |
| 3--4 | Logical-edge figure, observation table, validation, diagnostics | PASS |
| 5--6 | Protocol, model table, result table, checkpoint curves | PASS |
| 7--8 | Heatmap, round robin, ablations, limitations, conclusion, reference start | PASS |
| 9 | Bibliography | PASS |
| 10 | Bibliography and hyperparameter appendix | PASS |
| 11 | Additional-results and reproducibility appendix | PASS |

No page has clipped text, overlap, black squares, broken glyphs, visible link
boxes, unreadable figures/tables, or a blank tail page. Page 11 contains the
appendix and is intentionally not blank. The main text ends within the ICLR
nine-page initial-submission limit; references and appendix follow.

## Typography and figure polish

The 2026-08-30 polish pass changed presentation only:

- added T1 font encoding while retaining the official Times body family;
- made bibliography URLs use the surrounding font;
- regenerated all figures as vector PDF plus 320 dpi PNG previews;
- locked figure text to Times New Roman with STIX math and embedded Type 42
  fonts;
- standardized percentage axes, explicit denominators, restrained blue/gold
  palette, markers, and line styles;
- removed redundant internal figure titles and added a direct callout for the
  Figure 1 edge difference.

No paper claim, table value, bibliography entry, source result, or D14--D16
evidence boundary changed in this pass.

## Final disposition

Template migration and the requested P1 wording/related-work/limitation closure
pass. The candidate is ready for a fresh independent simulated review keyed to
the new full PDF hash, but it is not submission-ready until the author-approved
AI-use disclosure and anonymous supplement gates are closed.

No commit or push was performed.
