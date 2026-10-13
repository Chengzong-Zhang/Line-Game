# LIFELINE AAAI-targeted content draft

Status: content-reconstructed draft; not submission-ready and not yet typeset
with the official AAAI author kit.

This draft preserves the current verified evidence while changing the paper's
center of gravity from a claimed topology/history learning advantage to an
auditable rule--state benchmark and diagnostic protocol. In particular, it:

- frames LIFELINE as a benchmark for separating occupancy, logical edges,
  repetition history, and legal-action masks;
- keeps the side-five exhaustive negative result and the side-six mask-free
  history-legality witness with their existing limitations;
- presents the CNN/GNN comparison as a receipt-bound baseline audit, not a
  global representation ranking or causal feature result; and
- states the same-backbone factorial ablation, diversified evaluation, and
  held-out-size verification as future work rather than inventing results.

The original ICLR-style source and its byte-bound QA records are preserved in
the parent directory. The preamble in `main.tex` is a compact, buildable
content-draft preamble. Before submission, replace it with the current AAAI
author-kit style and rerun all final PDF, anonymity, supplement, and
submission-gate checks.

## Build check

From this directory:

```powershell
pdflatex -interaction=nonstopmode -halt-on-error main.tex
bibtex main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

The verified local build completed with exit code 0 for all commands and
produced an 11-page US-Letter PDF. The current draft PDF SHA-256 is:

`F298A8839AE5AC602712639197C3100DD399812249E85E5CE6C68E074EAB23A4`
