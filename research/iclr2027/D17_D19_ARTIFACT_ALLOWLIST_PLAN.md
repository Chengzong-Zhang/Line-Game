# D17-D19 Artifact Allowlist Plan

Status: **fail-closed; no current result is allowlisted**.

## Current boundary

The complete `results/formal/d17_d19/` tree is local-only. The repository
ignores the directory as one unit and does not use negated (`!`) rules to
re-include anything beneath it. This covers, among other generated artifacts:

- task, attempt, pair, and other per-execution trees;
- `game_manifest.jsonl`, `tasks.jsonl`, and task bundles;
- `autodl_stage/` snapshots;
- runner-control, stdout, stderr, and other control logs; and
- recovery trees, transient state, and incomplete-run material.

This plan does not authorize adding any existing D17-D19 result, changing a
frozen protocol or binding, or treating a partial run as formal evidence.

## Future candidate categories

Only a separately reviewed, compact evidence package may later be considered
for Git. Candidate categories are:

1. aggregate tables or machine-readable aggregate results;
2. concise result and completeness summaries;
3. a compact receipt ledger;
4. a hash manifest binding evidence to source, configuration, and protocol;
5. an independent verification report.

These are categories for future review, not filename-based exceptions. Files
with these names remain ignored when they are inside
`results/formal/d17_d19/`.

## Promotion gate

Before any future inclusion, all of the following are required:

- the run is complete at its declared formal scope and is not smoke, pilot,
  partial, failed, or recovery-only output;
- the compact package is independently verified against the local artifacts;
- receipts and hashes bind the exact source, configuration, protocol, and
  evidence inputs;
- local paths, credentials, checkpoints, raw trajectories, task/attempt trees,
  staging snapshots, and logs are absent;
- the proposed files and destination outside the ignored tree receive an
  explicit review; and
- artifact-policy tests, `git diff --check`, and the tracked-file ignore audit
  pass before staging.

Do not reopen the ignored result tree with negated `.gitignore` rules. A future
curated package must be materialized at a separately reviewed path outside that
tree.
