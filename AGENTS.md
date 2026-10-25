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

## Future product AI training

- New supervised product AI training data must come from the versioned defensive teacher:
  `web/web前端/DefensiveTrainingTeacher.js`, through
  `web/tools/defensive-training-data-v1.mjs`. Fit isolated candidates with
  `web/tools/train-defensive-policy-v1.mjs`; do not restart retired shallow-label
  or rollout-only product training protocols to bypass this requirement.
- Terminal-only reinforcement continuation is also supported by the separately
  versioned `web/tools/train-terminal-policy-v4.mjs` protocol: nonterminal
  rewards are exactly zero, gamma is 1, and returns use only native naturally
  terminated games. A truncated game never supplies a return or an update.
  Complete full-action Minimax from `PassOpportunityTrainingTeacher.js` gates
  eligible decisions and a fixed defensive mask; its leaf scores are never
  environment rewards. Keep selected-state coverage and this mask's effect
  explicit. Do not call context-only or singleton-mask decisions training.
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
