# Repository working agreement

These rules apply to all future work in this repository.

## Default project skill

- Use `lifeline-dev` by default when working on this project; the user does
  not need to mention the skill explicitly.
- At the start of a project task, read
  `C:/Users/zcz/.codex/skills/lifeline-dev/SKILL.md` and follow its applicable
  guidance. Load only the supporting references needed for the current task.
- If that local path is unavailable, look for `lifeline-dev` in the current
  skill catalog. If it cannot be found, report the missing skill rather than
  silently claiming to have applied it.
- The user's current instructions and this repository agreement take
  precedence over the skill. Using the skill does not expand the task's scope
  or grant permission to push, deploy, upload, or perform other external actions.

## Tencent Cloud SSH access

- For authorized work on this project's server, Codex should connect directly
  using the existing passwordless SSH setup on this Windows computer. Do not
  ask the user to enter or share the server password for routine connections.
- SSH alias: `lifeline-cloud`; target: `ubuntu@81.70.240.251` (port 22).
  Use `ssh -o BatchMode=yes -o ConnectTimeout=15 lifeline-cloud <command>`.
  Read-only connection check:
  `ssh -o BatchMode=yes -o ConnectTimeout=15 lifeline-cloud "echo LIFELINE_PASSWORDLESS_OK"`.
- Local SSH configuration: `C:/Users/zcz/.ssh/config`. Dedicated private key:
  `C:/Users/zcz/.ssh/lifeline_tencent_ed25519`. These are local machine files;
  never copy private-key contents or passwords into this repository, chat,
  logs, or verification evidence. The alias/key may be absent on other machines.
- Passwordless access was verified from Codex on 2026-10-26. If a connection
  fails, inspect local configuration and connectivity first; keep host-key
  checking enabled, do not overwrite existing keys, and report any remaining
  blocker. Use non-interactive authentication so automated commands fail
  promptly instead of waiting for a password.
- This authorizes using the connection for the current project task; it does
  not independently authorize unrelated server changes, deployment, deletion,
  service restarts, or access to unrelated data. Apply the user's task scope.

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

## Long-running experiment reliability

- Every new long-running training or evaluation job must include durable
  checkpoints, an explicit resume path, and automatic recovery from unexpected
  worker exits before it is launched. This is a standing owner requirement.
- Persist completed evaluation units incrementally. Resume from the latest
  validated progress without retraining completed models or rerunning completed
  games. Preserve interrupted evidence and isolate any incomplete trailing write.
- Run unattended jobs under supervision independent of the current terminal or
  Codex session. Prevent duplicate workers, record exit codes and progress, and
  provide an explicit pause/stop mechanism. Recover after user login when needed.
- Test interruption and recovery before a long run. Stop retries on evidence or
  configuration corruption and bound repeated failures without progress.
- Keep training, evaluation, recovery checks and final verification status
  distinct. A restarted process is not a completed or scientifically verified run.


## Future product AI training

- New product AI training data must come from the versioned defensive teacher:
  `web/web前端/DefensiveTrainingTeacher.js`, through
  `web/tools/defensive-training-data-v1.mjs`. Fit isolated candidates with
  `web/tools/train-defensive-policy-v1.mjs`; do not restart retired shallow-label
  or rollout-only product training protocols to bypass this requirement.
- Every label must prove actual completed Minimax depth >= 3. Requested depth,
  partial iterations, timed-out fallbacks and heuristic-only actions are not
  sufficient. The current teacher additionally requires at least two rounds of
  actual opponent actions (`max(3, 2 * surviving seats)` plies), full legal roots
  including PASS, and exact root values. Insufficient budget emits no label.
- Prioritize defense, prevention of repeated cuts, and persistent attacking
  structures connected through intact logical edges to the initial node.
  Preserve complete rules/history/actor state and verify the shared contract
  both when generating and consuming labels. Frozen old data/results are
  evidence, not compliant new training data; never silently relabel them.
- Keep new models isolated until separate strength and product-admission
  verification. See `docs/verification/defensive-training-20261025.md` and run
  `node web/web前端/tests/verify-defensive-training-v1.mjs` for the bounded
  teacher and recovery regressions. This does not authorize long training,
  automatic promotion or external publication.

## Organized local workspace

- Canonical documentation and tasks now live in `working/docs/` and `working/task/`.
- Run `working/tools/setup-layout.ps1` to restore local compatibility links after a clone; use `-Check` to verify them.
- Platform `project/` directories are links to independent worktrees, not merged source copies. Inspect the owning worktree before editing.
- Frozen research and nested Git worktrees keep their original physical paths. Use `core algorithm/research/` and `working/local_artifacts/` as navigation entries; do not recursively delete through them.
- Put new scratch outputs under `working/local_artifacts/` or `working/tmp/`. Pytest cache is configured at `working/.pytest_cache/`.
