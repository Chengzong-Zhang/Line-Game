# Size-transfer v1 pre-launch calibration

Date: 2026-10-07 (Asia/Shanghai)

Status: `PRELAUNCH_CALIBRATION_COMPLETE_WITH_CPU_COST_RISK`

This is a launch receipt, not a strength result or formal evidence.

## Frozen scope

- Families: `padded_cnn`, `grid_gnn`, `topology_gnn`.
- Transfer arm: `transfer_all` only.
- Fine-tuning seeds: `2026092201`, `2026092202`, `2026092203`.
- Stages per family/seed: 48, 64, and 80 game-attempt iterations.
- Board sizes in every target stage: 5 through 15.
- Total: 9 chains, 27 stage directories, 1,728 game attempts, and at most 6,912 optimizer updates.
- Existing formal checkpoints remain read-only sources. New artifacts stay under `results/pilot/`.

## Environment and source closure

- Python: 3.10.20.
- PyTorch: 2.7.1+cu118.
- Calibration device: CPU, `torch.set_num_threads(1)`.
- Source checkpoint SHA-256 values:
  - Padded-CNN: `934f12b8c2356afb1d630275135e8fd14893dc5b8b4b2e2ce8c98c4f9839bf15`
  - Grid-GNN: `0463c247ec42889fb30c5a23d4ed9b21c090495f2084a80d07b920edb8632a72`
  - Topology-GNN: `7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207`
- All three source probes passed 44/44 positions over sizes 5–15, both start players, and initial/one-step states.

## Short n=15 self-play calibration

Configuration: PUCT-16, `max_plies=32`, one game, no optimizer update. These runs are throughput/truncation measurements only.

| Family | Wall time | Environment steps | Result |
|---|---:|---:|---|
| Padded-CNN | 31.564 s | 32 | truncated |
| Grid-GNN | 1.859 s | 3 | completed |
| Topology-GNN | 27.141 s | 32 | truncated |

A separate Padded-CNN/Topology-GNN run with `max_plies=512` exceeded three minutes without returning a completed stage receipt and was stopped. It did not modify any formal artifact.

## Update and storage calibration

With a real n=15 batch of 32 replay samples, four CPU updates took:

| Family | Four updates | Per update |
|---|---:|---:|
| Padded-CNN | 2.598 s | 0.649 s |
| Grid-GNN | 1.876 s | 0.469 s |
| Topology-GNN | 1.919 s | 0.480 s |

A 1,000-sample n=15 checkpoint was 5.05 MB (4.82 MiB). This is only a size probe; the 50,000-sample replay target was not materialized because its construction caused excessive temporary memory. Reserve at least 120 GB for pilot checkpoints, logs, transactions, and recovery headroom.

## Conservative resource budget

Using the 32-ply n=15 measurements linearly as a worst-case 512-ply upper bound gives approximately 201 CPU-hours of self-play for all 1,728 attempts. Adding updates, checkpoint I/O, and restart margin, the launch cap is **240 CPU-hours** and **120 GB** of local disk. Actual cost may be lower because board sizes are sampled uniformly and some games terminate early. No paid or cloud resource is authorized by this receipt.

## Verification boundary

- Runner fault/transaction tests: four test methods reported `OK`; the fault-boundary and supervisor cases were also run separately with process exit code 0.
- `py_compile`: exit code 0.
- Old formal weights and formal result trees: not modified.
- This receipt does not establish CUDA determinism, cross-engine rule equivalence, chess strength, or formal readiness.
