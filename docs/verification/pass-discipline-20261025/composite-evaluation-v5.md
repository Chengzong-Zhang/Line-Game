# Explicit v5 composite evaluation

The v5 manifest selects the unchanged original easy, three-v4 and three-v1
candidates and the separately identified hex continuation. The original 96-game
v4 run still fails its original four-update hex completion gate. The new stage
adds one natural 4-player triangle-size-5 BLACK game and one nonzero update;
the hex continuation cumulatively has 25 natural games and 4 actual updates.
No old candidate, game, counter or identity is relabelled as a new training run.

`terminal-policy-composite-v5-r2-independent-audit.json` records the independent
composite review and each model's freshly recomputed
`runtime_parameters_sha256`. The three old source identities remain v4; hex
retains its distinct v5 identity. The adapter requires the unchanged revision-2
protocol bytes, SHA256
`6af123a320867571df97e73c65d82a758d97e5b34d53b8aab74305c52a599531`.

The campaign is 34 fresh natural games in 8 paired layout blocks plus the
original fixed/shared scenarios, under one independently supervised 1500-second
budget. The first checkpoint deadline survives resume. Final admission checks
all nine stage report hashes, distinct model sources, the original deadline and
elapsed time from the first supervised worker; supervisor resume cannot add a
new evaluation budget. Completed games and actions are never repeated.

## Bounded verification

- `node web/web前端/tests/verify-pass-discipline-evaluation-v1.mjs`: 13 PASS.
- `node web/web前端/tests/verify-pass-composite-admission-v5.mjs`: 7 PASS.
- Actual composite read-only independent audit: PASS. This is a training
  evidence check, not task or strength admission.
- Read-only baseline inventory: `evaluation-baseline-v5-source-inventory.json`.

The new test suite uses synthetic candidates, injected audit results and injected
decisions in a temporary directory. It covers distinct identities, real runtime
parameter digests, fixture/candidate/alias corruption, v5 evaluator resume,
nine-stage idempotence and both worker/supervisor deadline gates. These fixtures
are not formal training or strength evaluation.

## Prepared commands

Working directory: `C:/Users/zcz/.codex/worktrees/pass-discipline/line game`.

```powershell
node web/tools/prepare-pass-discipline-evaluation-v1.mjs --run-root local_artifacts/pass-discipline-v5-composite-r2-20261026-prepared --protocol web/tools/configs/pass-discipline-acceptance-v2-20261025.json --baseline-root 'C:/Users/zcz/.codex/worktrees/defense-15-players/line game' --candidate-root 'C:/Users/zcz/.codex/worktrees/pass-discipline/line game' --mode campaign --composite-manifest local_artifacts/terminal-policy-composite-v5-20261025.json --wall-seconds 1500
```

Preparation has completed and must not be rerun against the existing directory.
Wait for the root task's final source freeze before launch:

```powershell
& ./web/tools/launch-defensive-warmstart-v2.ps1 -JobPath ./local_artifacts/pass-discipline-v5-composite-r2-20261026-prepared/job.json -InstallLoginRecovery
```

This reused launcher starts an independent hidden supervisor and installs the
run-specific login shortcut
`Lifeline-Defensive-Warmstart-9f6f0cb3625998bd.lnk`. The shortcut must be removed
after this campaign is finished; the launcher receipt records its absolute path
and supervisor PID. Read-only launcher and recovery preflight passed; before
first launch the latter correctly returns `MISSING_STATE_NO_FIRST_LAUNCH`.

Place `PAUSE` or `STOP` in that run directory to halt. Authorized resume uses
`node web/tools/supervise-three-player-job.mjs --job local_artifacts/pass-discipline-v5-composite-r2-20261026-prepared/job.json --resume`
and retains the campaign's original
deadline and completed evidence. Budget exhaustion or evidence corruption does
not authorize extra games or time.

After natural campaign completion and before any metadata activation:

```powershell
node web/tools/finalize-pass-discipline-admission-v1.mjs --campaign-root local_artifacts/pass-discipline-v5-composite-r2-20261026-prepared --protocol local_artifacts/pass-discipline-v5-composite-r2-20261026-prepared/protocol.json --composite-manifest local_artifacts/terminal-policy-composite-v5-20261025.json --source-root 'C:/Users/zcz/.codex/worktrees/pass-discipline/line game' --output docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json
```

## Permanent limits

The unused three-v4 raw17 head still selects opening PASS at sizes 5/7/9.
Revision 2 tests the actual unguarded v4 search with newly trained placement
coefficients, its original opponents/width/plies and `learned_pass=false`.
It does not declare that unused PASS head successful.

The original 18 native 4–6-player hexagon games supplied zero eligible gradient
samples. Hex training and the new targeted update come from 4-player triangle5;
native hex behavior remains a transfer question. Size9 and other player counts
remain bounded snapshots. Even a future scoped PASS-discipline admission is not
global strength, browser, device, WeChat or public-release verification.
