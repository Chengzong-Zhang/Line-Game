# AutoDL GPU v2 path

## Scope and safety boundary

This path improves GPU occupancy for future LIFELINE-RL training without
rewriting or rerunning the completed D14--D16 experiment. The frozen legacy
AlphaZero source identity remains:

```text
21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c
```

All new runtime code lives under `lifeline_rl_autodl/` and has its own v2
checkpoint source identity:

```text
017ed1f75aa1ec54e728250fc3763f4d2746eb38b383dcabc57a2390d5aab6c5
```

A v2 checkpoint must not be loaded as a legacy D14--D16 checkpoint, or vice
versa.

The current Job file deliberately contains the invalid placeholder
`REPLACE_WITH_COMPATIBLE_PYTORCH_IMAGE_UUID`. Do not replace it until a live,
compatible AutoDL image has been selected and the user has explicitly approved
the paid benchmark. Never release an AutoDL instance automatically.

## What changed

- Multi-actor self-play advances independent games together and commits each
  completed group atomically to replay.
- Batched PUCT collects one newly reached leaf per active tree and evaluates
  those leaves in one neural batch.
- Mixed board sizes are padded safely, with each board's PASS logit restored to
  its own final action index.
- CUDA inference supports AMP, while the GPU smoke calibrates actor/batch supply
  through the real forward, backward, and optimizer path.
- Legacy AlphaZero files are reused read-only; the v2 trainer binds checkpoints
  to both the legacy sources and the new AutoDL sources.

## Local readiness evidence

The real CPU readiness gate passed on 2026-08-28. It read
`state_aliasing/pairs_v1.json`, parsed six real states at sizes 5 and 6, built
the 63,171-parameter Topology-GNN, checked action shapes 16/16/22/22, performed
a batched forward pass, and ran two PUCT visits per root.

The readiness command is embedded in `autodl/game_gpu_v2.job.toml` and must not
be run manually again before the product run. `autodl-direct run` will execute
it locally once before any paid API write.

## CUDA smoke and benchmark result

The remote gate runs a 20-second task-shaped CUDA smoke. It exercises one real
batched-PUCT search plus a sustained BF16 replay-training loop, probes actor and
batch candidates, writes the selected profile to
`$AUTODL_WORK_DIR/throughput_profile.json`, and requires at least 50% GPU
utilization before the bounded benchmark starts.

The v3c benchmark completed on 2026-08-28 as Job
`ld-lifeline-game-gpu-v3-5151be21`, reusing instance
`pro-7879e5f79219` (RTX 5090, 32 GB). The 25.208-second smoke averaged 62.643%
GPU utilization, peaked at 7,009 MiB, and selected a 65,536-example BF16 replay
batch. The formal 45.594-second benchmark averaged 50.7% GPU utilization and
peaked at 7,005 MiB.

The benchmark separated the two bottlenecks: 16-actor self-play achieved
48.1904 actor plies/s, while the 30.042-second replay-training segment completed
514 optimizer steps at 1,121,269 examples/s. The replay rows were replicated
from the real fixture for throughput calibration, so this is systems evidence,
not a learning-quality result or a rerun of D14--D16. The practical conclusion
is that the 5090 is useful for large replay SGD batches, while Python/PUCT
self-play remains the limiting path.

## Prepare the free local stage

From Windows PowerShell:

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B `
  'C:\coding\py\line game\research\iclr2027\scripts\prepare_autodl_game_stage.py' `
  'C:\Users\zcz\autodl-game-stage\iclr2027-v2-20260828'
```

This copies only source, configuration, packaging metadata, and the small real
fixture. It excludes the large `results/` tree and refuses to overwrite a
non-empty destination. Inspect `STAGE_MANIFEST.json` before a paid run.

## Paid-run checklist

1. Ensure the AutoDL balance satisfies the local policy minimum.
2. Select an existing AutoDL image compatible with Python 3.11, PyTorch 2.7.1,
   and CUDA 12.8, then replace only the Job's `image_uuid` placeholder.
3. Review the chosen GPU and quoted price, then obtain explicit approval for
   the paid benchmark.
4. After approval, run exactly one command from Windows PowerShell:

   ```powershell
   & 'C:\Users\zcz\.local\AutoDLRunnerDirect\venv\Scripts\autodl-direct.exe' run `
     'C:\coding\py\line game\research\iclr2027\autodl\game_gpu_v2.job.toml'
   ```

Do not run `doctor`, authentication checks, wallet checks, a separate dry-run,
or a second manual readiness command. If the product run is interrupted or
reports a real error, use its reported job identifier with the documented
status/log/recovery flow; do not start another paid run blindly.
