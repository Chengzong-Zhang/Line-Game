# ICLR 2027 post-run PDF QA receipt v3

QA date: 2026-08-31 (Asia/Shanghai)  
Disposition: **PDF QA passes; source/implementation corrections verified;
submission gates remain open**

This is a new receipt for the candidate rebuilt after the source changes that
invalidated the historical `B746777E...543D0E` receipt, review, and gate. The
historical records remain unchanged and must not be applied to this PDF.

## Bound inputs

| Artifact | SHA-256 |
| --- | --- |
| `main.pdf` | `AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC` |
| `main.tex` | `8C3C439363D63E85063B80703D604E9ABDED3689F0AD9AAF86AE398474A86D55` |
| `references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| `D14_D16_TERMINOLOGY_ERRATUM.md` | `275B303903A89C3C7697BC76A4E7D59E93325B281334CD9F6072DFD14FDDAF3E` |
| D14--D16 receipt ledger | `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114` |
| D14--D16 canonical aggregate | `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C` |
| D17/D18 local independent verifier report | `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E` |
| D14--D16 dependency lock | `CE828028578A87CAA31E7B3B69C0191458546533E21C0E1DE6180ACCDFBB879F` |
| local environment verification receipt | `FBAFAA8D7D748DEAD69B52EE042C79DCFBDE75675660FEEF1C53F167EDA97EB1` |

The official ICLR 2027 archive, style, and bibliography-style hashes remain
`0D940DFA...529E`, `797DEEF4...EA6`, and `2D67552D...4C5`, respectively.
`main.tex` contains neither `\iclrfinalcopy` nor a manual `\lhead`.

## Source and scientific corrections

The rebuilt candidate makes three evidence-bound corrections without changing
any D14--D16 result number:

1. Eq. (3) now matches the relational block implementation: a biased self
   projection, bias-free relation projections over degree-normalized relation
   means with zero-degree clamping, a ReLU residual update, LayerNorm, and an
   explicit padded-node mask. The rendered equation remains legible and is
   numbered (3).
2. The search-baseline paragraph now defines Random, Greedy, depth-2/3
   approximate Minimax, and adversarial UCT-MCTS-16. The suffix 16 is stated to
   match only the simulation count, not FLOPs, wall time, rollout transitions,
   expanded nodes, memory, or hardware cost.
3. Every live manuscript use of the 30,600 total is phrased as
   `task-indexed replay-verified game records`. The paper retains the fact that
   each D16 200-game task repeats only two deterministic color-conditioned
   trajectories and makes no independent-game inference.

The D17/D18 extension remains excluded: execution completion does not override
the failed D18 diversity gate, global `formal_ready=false`, or the closed D19
gate. No D17--D19 performance row is admitted.

## Build and structural checks

The verified build used one initial pdfLaTeX pass, BibTeX, and three
post-BibTeX stabilization passes. All five commands exited 0.

- `pdfinfo`: 11 pages, 612 x 792 pt US Letter, rotation 0, unencrypted, no
  form, and no JavaScript.
- `pdffonts`: every listed font is embedded and subset.
- Stable `main.log`: zero overfull boxes, undefined citations/references,
  rerun requests, LaTeX errors, or fatal errors. Two non-blocking underfull
  diagnostics remain.
- `main.blg`: zero BibTeX warnings or errors; the statistics line
  `warning$ -- 0` is not a warning.
- PDF author and title metadata are empty; the visible author block is
  anonymous under the official review style.
- Extracted-text scans found zero author-name, username, email, Windows
  absolute-path, or repository-path hits.

The extracted PDF also contains zero literal D17, D18, or D19 labels. This is
an exclusion check, not evidence that those experiments passed.

## Page-by-page visual check

All 11 pages were rendered with Poppler at 150 dpi and inspected.

| Pages | Result |
| --- | --- |
| 1--2 | PASS; title, anonymous author block, abstract, related work, and Eqs. (1)--(2) are intact |
| 3--4 | PASS; Figure 1, Table 1, definitions, propositions, and baseline text are aligned |
| 5 | PASS; corrected Eq. (3), masking prose, and Table 2 are legible and within the text block |
| 6--7 | PASS; Tables 3--4 and Figures 2--3 are readable with no overlap or clipping |
| 8--10 | PASS; limitations, conclusion, references, and appendix Table 5 remain within margins |
| 11 | PASS; appendix text is present and the remaining white space is intentional |

No page contains clipped text, overlap, broken tables, black squares,
unreadable glyphs, visible link boxes, or an accidental blank tail page. The
main text and reproducibility statement finish on page 8 before the references
continue; the appendix occupies pages 10--11.

## Environment-lock check

The exact 19-package Windows/CUDA lock was checked in the retained `rl310`
environment against the formal execution metadata. The local receipt reports
`ok=true`, no errors, CPython 3.10.20, PyTorch 2.7.1+cu118, CUDA 11.8, cuDNN
90100, and the expected RTX 4060 Laptop GPU.

This closes identification and verification of the retained software
environment. It does not prove a fresh clean-room install from the lock, bind
an anonymous supplement archive, or reproduce the original formal run on new
hardware.

The final local code checks also passed: the complete research suite reported
261 passed tests plus 174 passing subtests; the supplement-builder self-test
reported ten passes and one Windows host-capability skip for creating a real
symlink, while the separate simulated reparse-point rejection test passed.
`ruff check` and `git diff --check` both passed. These checks validate the
current local tree, not an author-approved final archive.

## Remaining submission gates

- The mandatory AI-use statement is absent from both source and PDF. This is
  deliberately **OPEN** pending author-by-author factual confirmation and the
  separate live-form decision.
- The anonymous supplement still requires an author-approved exact allowlist,
  archive hash, identity/path/metadata scan, and independent clean-copy gate.
- A fresh clean-environment installation/reproduction receipt is not yet
  available; the retained-environment receipt is narrower.
- The live OpenReview form has not been inspected or completed by an author.
- Any byte change to `main.tex` or `main.pdf` invalidates this receipt and
  requires a new hash-bound QA, review, and submission gate.

No training, formal game, paid AutoDL action, OpenReview action, commit, or push
was performed by this PDF rebuild and QA.
