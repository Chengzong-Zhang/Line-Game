# Two-player neural candidate posttraining

This run warm-starts all 17 exported Web neural models: 12 ResearchAI networks
(three original D14 models and nine transfer-v1 models) and five model-free
networks (DQN, PPO, SAC, GAIL and GAN). Original manifests, assets and historical
training checkpoints are preserved.

## Training contract

- Method: supervised policy distillation from the current Web engine's legal
  point-action teacher distributions, with `0.1 * KL(parent || candidate)`.
- Every model receives exactly 100 Adam updates, batch size 16, learning rate
  `0.0001`, gradient norm limit 1, seed 20261021, deterministic single-thread CPU.
- Model initialization uses the existing F32 asset. Optimizer and RNG state are
  reset for this new experiment. This is **not** resuming the historical
  DQN/PPO/SAC/GAIL/GAN training algorithms.
- The 66 independent episode files cover every size from 5 through 15.
  Whole-episode separation gives 1199 training and 593 validation samples.
  Of the 66 episodes, 23 end naturally and 43 are truncated. Truncated positions
  are used only for policy imitation; no return/value label is inferred.
- PASS is excluded from the loss. Dedicated value and PASS head parameters are
  frozen where they exist. Shared backbone changes can still change their
  predictions. The model-free MLP action head remains trainable as one tensor.
- PPO/GAIL/GAN deliberately follow the shipped browser's ReLU activation,
  whereas the old Python ActorCritic trainer used Tanh.
- The fixed final update is exported; validation or arena results do not select
  an earlier checkpoint.

Candidate metadata preserves the parent's `trained_board_sizes`. The current
posttraining sizes are **5–15**, as recorded by the data manifest and independent
verification report. Historical checkpoint hash fields identify the parent;
current checkpoint hashes are in the new run's receipt.

## Reliability and bounded execution

The frozen worker saves the model, Adam state, Python sampling RNG and Torch RNG
after every update, fsyncs before atomically advancing its checkpoint pointer,
and retains the current and preceding committed states. Completed model hashes
are rechecked before skipping completed work. Incomplete temporary writes are
isolated. Source, config, data and parent drift is fatal.

`neural-training-recovery.json` records an actual worker kill after step 1 and
exact clean-versus-resumed equality across all 17 models, each run for three
updates. It also records duplicate lease rejection, completed-work preservation,
PAUSE/STOP handling and corruption/config-drift rejection. This is a bounded
recovery test, separate from the 100-update candidate run.

`neural-calibration.json` records CPU timing at sizes 5, 9 and 15, including
fsynced checkpoint writes. Its worst measured compute-only extrapolation is
about 445 seconds for 1700 updates; validation, hashes, I/O and contention are
additional costs. The independent hidden supervisor has a hard 1800-second
wall budget, a 660-second worker limit, and at most three restarts. Workers yield
after 600 seconds and continue from their last committed update. No persistent
scheduled job or login autostart is installed.

Run directory:
`local_artifacts/all-ai-posttraining-20261021/neural-training`

Write a `PAUSE` or `STOP` file in that directory to request a bounded stop.
The supervisor command is:

```powershell
node web/tools/supervise-three-player-job.mjs --job local_artifacts/all-ai-posttraining-20261021/neural-training/job.json
```

After checking the exit receipt and remaining budget, its `--resume` option
clears the explicit control marker and resumes the same validated run. Do not
change sources/configuration or bypass fatal identity/corruption checks.

## Independent output verification

```powershell
& 'C:/Users/zcz/anaconda3/envs/rl310/python.exe' -B web/tools/verify_neural_posttraining.py --run-root local_artifacts/all-ai-posttraining-20261021/neural-training --data-root local_artifacts/all-ai-posttraining-20261021/neural-data --config web/tools/configs/all-neural-distill-v1.json --output local_artifacts/all-ai-posttraining-20261021/neural-verification/verification.json
```

The verifier checks complete-model ordering and update counts, all evidence
hashes, state-to-F32 tensor equality, finite Adam tensors and per-parameter step
counts, frozen heads, exact sampler and Torch RNG states, and parent/candidate
cross-entropy on all validation positions. It also replays fixed actual engine
prefixes and compares 17 parents and 17 candidates through the browser's own
inference and encoders at sizes 5, 9 and 15, for 102 numerical parity probes.

The verifier does not replay all 1700 optimizer updates. Network construction and
batch assembly reuse the frozen Python helper, while browser inference supplies
an independent implementation check. Validation loss establishes teacher
imitation only. Playing strength and release acceptance require the separate
application arena and its replay verification; a completed distillation run
does not authorize automatic replacement of defaults.

Raw data, per-step states, logs and candidate F32 binaries remain local. Compact
receipts and hashes are kept here; the final result report records achieved
status separately from this frozen protocol description.
