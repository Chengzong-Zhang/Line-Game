# Size-transfer checkpoint atomicity and storage addendum

Date: 2026-10-09 (Asia/Shanghai)

Status: `RUNNER_FIX_TESTED; LONG_RUN_STORAGE_BUDGET_REQUIRES_RECALIBRATION`

This addendum supplements, and does not replace, `CALIBRATION_20261007.md` or
any pilot receipt. No historical checkpoint, receipt, formal source weight, or
pilot output was edited by this validation.

## Failure and repair

The 2026-10-07 pilot failure is consistent with `RecoverableRunner._checkpoint`
calling `AlphaZeroTrainer.save()` without an explicit path. Its default path is
`checkpoint_{iteration}.pt`; several game/update transactions in the same
iteration therefore rewrote the file still named by `latest.json`. If the new
checkpoint write succeeded but replacing `latest.json` failed, the old
manifest remained while its target had already changed.

The runner now writes every transaction checkpoint to a fresh
`runner-<uuid>.pt` path and passes that path to `trainer.save(path=...)`. A
manifest-replacement failure may leave an unreferenced checkpoint, but cannot
overwrite the checkpoint still named by the previous manifest. The existing
fail-closed recovery path can then resume from that previous manifest and
replay the one prepared transaction. This repair does not alter or recover the
historical stage whose checkpoint digest already disagrees with its manifest.

## Verification

All work used the local `rl310` Python environment and isolated temporary run
directories. The combined runner-suite invocation exceeded the foreground
execution window, so its individual methods and all six recovery boundaries
were run separately; each completed invocation exited 0.

- Manifest replacement fault regression: old manifest bytes and old checkpoint
  SHA-256 stayed unchanged; the orphan checkpoint was not selected; recovery
  completed one game and one update and emitted only `COMPLETE_NOT_FORMAL`.
- Recovery fault boundaries passed: `game_prepare`, `game_checkpoint`,
  `update_prepare`, `update_checkpoint`, `iteration_prepare`, and
  `iteration_checkpoint`.
- Clean runner/supervisor, corrupt transaction rejection/duplicate lock,
  pause/stop/evaluation append tests passed. The draft suite passed 8/8.
- Python rule/environment tests passed 17/17; `py_compile` passed for the
  modified runner and test.
- One real CPU smoke used the trusted Padded-CNN source, board size 5,
  `puct_simulations=1`, `max_plies=256`, one game, one allowed update, and a
  temporary run directory. It completed in 4.145 s: 1 completed game, 0
  truncations, 1 optimizer update, and 4 unique checkpoint files including
  initialization. Receipt status was `COMPLETE_NOT_FORMAL`, `formal_ready` was
  false. Temporary output was removed after collecting these measurements.

These checks do not establish strength, full-size throughput, CUDA recovery,
cross-engine rule equivalence, or formal readiness.

## Rule, config, source, and pilot audit

The frozen padded-CNN stage config remains board sizes 5–15, `grid_graph`,
`superko_mode=enforce`, PUCT 16, maximum 512 plies, four possible updates per
iteration, and replay capacity 50,000. The Python rule/environment regression
passed, but initialization correctly labels rule compatibility
`UNVERIFIED`; no Web/Python equivalence claim is made here.

The three formal source checkpoint hashes still match their export manifest:

- Padded-CNN: `934f12b8c2356afb1d630275135e8fd14893dc5b8b4b2e2ce8c98c4f9839bf15`
- Grid-GNN: `0463c247ec42889fb30c5a23d4ed9b21c090495f2084a80d07b920edb8632a72`
- Topology-GNN: `7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207`

The pilot tree still has six `COMPLETE_NOT_FORMAL` receipts whose latest
manifest digests match, plus the interrupted seed `2026092203`, stage 1, with
no stage receipt. Its existing manifest expects
`4eb9ad908c2f49e5869211d0aaa351f6a1dd4156579d6cf2db5966e7564bea5a`, while
the existing checkpoint hashes to
`79e0a95c50e24c31a8ac661044242e078678abe1dd1a566f9aa649c672a8ee4c`.
There were no size-transfer Python workers or worker locks at audit time. This
inconsistent stage remains untouched and must not be resumed in place.

## Storage recalibration

The current pilot's Padded-CNN directory contains 422 `.pt` files totaling
3,555,002,579 bytes (mean 8,424,177 bytes; largest 24,891,430 bytes). The six
completed stages plus the interrupted stage account for 415 completed
iterations and 7 initialization checkpoints. The new transaction-level naming
retains a separate file for each successful checkpoint rather than the prior
same-iteration overwrite. The frozen config permits 1 game checkpoint, up to
4 update checkpoints, and 1 iteration checkpoint per iteration: at most 6
runtime checkpoints per iteration, or 10,368 across 1,728 planned iterations.

Using the observed mean checkpoint size gives a rough full-plan projection of
about 87.3 GB (81.3 GiB), before uncertainty across model families, logs,
transactions, failed-write orphans, and free-space headroom. Stressing every
runtime checkpoint at the largest currently observed file size gives about
258.1 GB. These are planning estimates, not a guaranteed bound; the maximum
does not predict the actual distribution. Therefore the prior 120 GB reserve
is not cleared for a long run until storage is recalibrated across all three
families and a safe retention/free-space policy is validated. No long training
or paid compute was started or authorized by this addendum.
