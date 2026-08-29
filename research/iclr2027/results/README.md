# Result artifact policy

The repository stores enough evidence to inspect the reported conclusions
without placing hundreds of megabytes of generated trajectories and model
state in ordinary Git history.

## Versioned

- `formal/d13/`: compact gate, summary, learning-health, and joint-evidence
  files. The CSV game index is retained; the verbose JSONL trace is local.
- `formal/d14_d16/aggregate_v1/`: aggregate JSON and publication-ready CSV
  tables.
- `formal/d14_d16/run_v1/`: execution metadata, completion status, and the
  formal receipt ledger. The per-task execution tree is local.
- `formal/d14_d16/task_bundle_v1/`: frozen manifest and task definitions.
- `validation/`: compact validation, linkage, and verifier outputs, excluding
  large exploratory or block-level traces.

## Local by default

- `smoke/` and `pilot/`
- model checkpoints (`*.pt`, `*.pth`, `*.ckpt`)
- `formal/d14_d16/run_v1/tasks/`
- verbose `games.jsonl`, block journals, and runner console logs

The human-readable findings and their claim boundaries are in
[`../D14_D16_RESULTS.md`](../D14_D16_RESULTS.md),
[`../SUPERKO_ABLATION_RESULTS.md`](../SUPERKO_ABLATION_RESULTS.md), and
[`../SUPERKO_POLICY_MATRIX_RESULTS.md`](../SUPERKO_POLICY_MATRIX_RESULTS.md).
