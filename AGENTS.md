# Repository working agreement

These rules apply to all future work in this repository.

## Version control

- Inspect `git status`, the current branch, and the configured remote before
  editing. Preserve unrelated user changes.
- Keep source, tests, configuration, documentation, and compact verification
  evidence under version control.
- Use small, descriptive commits. Separate unrelated application, research,
  documentation, and deployment changes when practical.
- Use a `codex/` feature branch for risky or multi-step work. Direct changes to
  `main` are acceptable only for a reviewed, self-contained update requested
  by the repository owner.
- Before every push, review the staged diff, scan for credentials/private
  keys, check for unexpectedly large files, and run the relevant tests.
- Never rewrite shared history or discard local changes without explicit
  approval. Do not use force-push for routine work.

## Artifact policy

- Never commit credentials, TLS private keys, local databases, environment
  files, temporary directories, caches, logs, or generated archives/videos.
- Keep raw game trajectories, smoke/pilot runs, training checkpoints, and
  per-task execution trees local by default.
- Commit compact, reproducibility-relevant results: frozen protocols and
  configs, aggregate tables, result summaries, execution receipts, hashes,
  and independent verification reports.
- If a large binary is genuinely required for a release, use a GitHub Release
  or Git LFS after explicit review instead of placing it in ordinary Git
  history.

## Research change control

- Treat frozen experiment protocols and accepted formal artifacts as
  append-only evidence. Do not silently edit them during a run.
- Keep smoke, pilot, and formal outputs clearly separated, and never present a
  smoke or partial run as a formal result.
- Record source/config hashes and the exact verification command for formal
  claims whenever the workflow supports them.
