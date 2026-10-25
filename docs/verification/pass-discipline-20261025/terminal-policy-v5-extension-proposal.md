# Explicit hex continuation proposal v5

Status: implementation and bounded recovery review only; no formal extension has been launched.

The unlaunched `terminal-policy-v5-hex-extension-20261025-prepared` proposal is superseded and must not launch. Its prepared directory remains unchanged; its exact earlier sources are preserved separately under `local_artifacts/terminal-v5-r1-source-snapshot`. A fresh r2 preparation follows the additional independent review and semantic negative tests below.

The current r2 proposal is `local_artifacts/terminal-policy-v5-hex-extension-20261025-r2-prepared/job.json`, identity `fb343cdf48ae26ff27449fc77b72bb559ceb084ce9c0c2cefe71336d53f3339a`. It has zero new units and zero new completed games at preparation. The exact protocol copy is `web/tools/configs/terminal-policy-v5-hex-extension-r2-20261025.json`; the compact source/parent/old-candidate hashes and 24-case recovery receipt are in `terminal-policy-v5-extension-r2-preflight.json`. No formal extension has been launched by this task agent.

The original v4 run completed all 96 natural games, but hex had three actual nonzero updates against its frozen minimum of four. Its original `FATAL`, checkpoint, source, config, 96 game receipts and three completed non-hex candidates remain unchanged. The 18 original native-hex games provided zero gradient samples. This proposal does not change those facts or lower the original threshold.

## Minimal additional work

Prepare one new natural 4p triangle5 BLACK game, under a new stage/seed namespace, using the same reward, gamma one, fixed defensive mask and complete actual depth8/all-legal-root teacher requirement. This is transparently targeted after the original update-count failure, not a prespecified unbiased sample. Any incomplete analysis, singleton mask, truncation or genuine zero gradient cannot satisfy the new-update condition.

Carry the exact current hex 17 weights, baseline, baseline count4, optimizer step4, actual-update count3 and eligible-sample count4 from the original immutable checkpoint. There is no baseline or optimizer reset. New-stage `units` starts at zero and `completed` contains only the new stage. Global episode identity is `(stage_id, new training identity, local episode id)`; the reused local filename `hex-v1-seed0` is never a cross-stage deduplication key.

The unmodified frozen v4 trainer supplies canonical gameplay, Minimax analysis, masked sampling, SGD and its tested per-ply recovery. `terminal-policy-extension-v5.mjs` seeds its compatible checkpoint in a new run and wraps it with the explicit new provenance. The raw v4 adapter output is not the published continuation candidate. Separate `extension-candidate.json` and `extension-receipt.json` identify the direct checkpoint parent and distinguish `carry`, `new_stage` and `cumulative` counts. The wrapper requires at least one genuinely new nonzero update. It must retain the complete baseline/parameter chain and old failure.

## Composite identity and export

The three old candidates retain original identity `858cd0e839d71ecb6aa61e115eac3daa2ebce5313626f919bfad139587742909` and exact bytes. The new hex candidate has a different training identity and a direct checkpoint-parent hash. `compose-terminal-policy-v5.mjs` creates an explicit manifest with each alias's source run, schema kind, candidate path, candidate hash and training identity. It audits the old 96 and new stage separately and verifies their baseline/SGD connection. It never relabels all candidates as one training run.

On success, the composite describes 96 original plus one new natural game, with 25 cumulative hex games, three carried plus at least one new actual update, and separate new/cumulative sample counts. Native-hex gradient coverage remains zero because the added game is triangular. A runtime admission would be for triangular training transferred to native boards, subject to the separately frozen matched full-game checks.

The new export branch accepts only a verified formal composite and emits an `EVALUATION_ONLY` overlay using the existing runtime ABI. The top composite identity and each model's true source identity are both preserved. A fixture composite cannot be exported as a product model. The original v4 exporter is unchanged and cannot be used to hide the failed single-run contract.

Independent review required four further gates: bind fixture/stage flags to the actual frozen config and input; freeze old candidate byte hashes before continuation; recompute canonical placement/PASS feature values and order rather than trusting stored features; and bind the new game's cell, complete initial state and BLACK seat to the unique frozen configuration. These checks are in the r2 tools. `review-terminal-canonical-features-v5.mjs` adds the same canonical feature/configuration review to the original 96 games without changing the old reviewer or training sources. Its separate report `terminal-policy-v4-canonical-feature-review-v5.json` confirms 96 initial configurations, 1038 learner rows and 134300 feature values/order checks.

## Recovery and launch boundary

`verify-terminal-policy-extension-v5.mjs` creates a portable two-game parent fixture and verifies exact carry/new state, six interruption boundaries, idempotent finalization, duplicate wrapper exclusion, PAUSE, parent-byte corruption rejection, actual worker kill recovery, actual supervisor kill/restart, and the original absolute deadline. It compares recovered weights, baseline and counters; the parent fixture tree must remain byte-identical. Composite identity/hash and fixture-export negative cases are checked separately in the same suite.

Real-run preparation and launch commands, after final source review:

```
node web/tools/terminal-policy-extension-v5.mjs prepare --base-root local_artifacts/terminal-policy-v4-formal-20261025-stamped --run-root NEW_V5_RUN
powershell.exe -NoProfile -ExecutionPolicy Bypass -File web/tools/launch-defensive-warmstart-v2.ps1 -JobPath NEW_V5_RUN/job.json -InstallLoginRecovery
```

Preparation does not launch. The independent supervisor has a 300-second absolute budget, bounded restarts, worker/wrapper exclusion and login recovery. `PAUSE`/`STOP` belong to the new run only. All old and new frozen inputs remain byte-identical; a failure requires investigation rather than deleting receipts or adjusting inherited counts.

After a successful new stage:

```
node web/tools/terminal-policy-extension-v5.mjs audit --run-root NEW_V5_RUN
node web/tools/compose-terminal-policy-v5.mjs compose --extension-root NEW_V5_RUN --output NEW_COMPOSITE_MANIFEST
node web/tools/compose-terminal-policy-v5.mjs audit --manifest NEW_COMPOSITE_MANIFEST
node web/tools/compose-terminal-policy-v5.mjs export --manifest NEW_COMPOSITE_MANIFEST --output EVALUATION_OVERLAY_FILE
```

Training completion, composite verification, raw/deployed runtime behavior, full-game acceptance and external release remain separate. In particular, the raw17 three-v4 opening-PASS diagnostic remains preserved; its actual deployed object is the original search algorithm with the continued placement coefficients.
