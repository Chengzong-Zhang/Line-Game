# Size-transfer family checkpoint smoke addendum

Date: 2026-10-09 (Asia/Shanghai)

Status: `THREE_FAMILY_CPU_SMOKE_ONLY`

This note supplements `CHECKPOINT_ATOMICITY_ADDENDUM_20261009.md`. It does not
replace the earlier storage estimate or certify long-run capacity.

## Measurements

One isolated CPU smoke was run per trusted formal source checkpoint. Each used
board size 5, one game, PUCT 1, a 256-ply cap, batch size 1, one allowed update,
and replay capacity 64. Each run completed one game without truncation and
committed one optimizer update. Outputs were temporary and removed after
collecting these measurements.

| Family | Elapsed | Runtime checkpoint files* | Total checkpoint bytes | Largest file | Receipt |
| --- | ---: | ---: | ---: | ---: | --- |
| Padded-CNN | 4.145 s | 4 | 2,226,696 | 821,808 | `COMPLETE_NOT_FORMAL` |
| Grid-GNN | 4.839 s | 4 | 2,253,386 | 830,708 | `COMPLETE_NOT_FORMAL` |
| Topology-GNN | 2.803 s | 4 | 2,291,150 | 845,052 | `COMPLETE_NOT_FORMAL` |

*Includes the initialization checkpoint plus the game, update, and iteration
checkpoints.

The three source weight SHA-256 values matched the export manifest at the time
of the smoke (Padded-CNN `934f12b8c2356afb1d630275135e8fd14893dc5b8b4b2e2ce8c98c4f9839bf15`,
Grid-GNN `0463c247ec42889fb30c5a23d4ed9b21c090495f2084a80d07b920edb8632a72`,
Topology-GNN `7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207`).

These tiny-board measurements are pipeline checks only. They do not represent
the replay-buffer growth, large-board checkpoint distribution, full-size
throughput, or recovery determinism needed to clear the 120 GB long-run reserve.
The 87.3 GB mean projection and 258.1 GB observed-maximum stress scenario in
the earlier addendum remain the relevant planning warning; no long run was
started.
