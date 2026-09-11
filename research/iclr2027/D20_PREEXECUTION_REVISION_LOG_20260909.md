# D20 pre-execution revision log — 2026-09-09

This record preserves the unexecuted D20-v1 registration before replacing it
with a computationally viable, independently calibrated D20-v2. It is not an
experiment result and does not alter D19-v2.

## Archived v1 bindings

| Item | SHA-256 |
| --- | --- |
| `configs/d20_matched_ablation_manifest.json` | `9E9DDB40008BEE8BB87F920376978C57F9EFA5BEB8B29B0510D28395DE195246` |
| `D20_MATCHED_ABLATION_PROTOCOL.md` | `C4565C78D7296E3EA74CB52C703364C3FCDCD547696253AC678F31E02407392A` |
| `scripts/d20_matched_ablation_runner.py` | `93C6073694709257DBF8F90F89BA1E908B99B841AEB5C07D5395E35053B74880` |
| `scripts/verify_d20_matched_ablation.py` | `C12EF79A7E237A48288056A673270F990946D12D8A2DDE762F1DB354799C8B36` |

## What was and was not executed

- CPU task-shaped readiness passed: complete-snapshot encoding, PUCT self-play,
  and a real AdamW update.
- A 20-second CUDA task-shaped smoke passed after setting the documented
  `CUBLAS_WORKSPACE_CONFIG` deterministic workspace.
- No D20-v1 training task, checkpoint, formal evaluation task, aggregate, or
  formal verification was created.
- Timing probes are not experimental results. At n=10, one UCT-64/depth-80
  action took about 27.4 seconds; a full probe game was interrupted before
  completion. UCT-16/depth-80 took about 5.55 seconds per action.
- A four-game, non-registered screening probe had Minimax depth 2, cap 8 beat
  UCT-16 four times. This does not establish stronger-opponent status.

## Reason for the revision

The v1 plan required 20,480 PUCT-16 / UCT evaluation games, including 5,120
UCT-64 games. The measured action cost makes that plan a multi-week local run,
not a reproducible completion. D20-v2 keeps the same training factorial and
uses a fixed, inexpensive Minimax candidate only after a separately registered
five-block calibration demonstrates a lower confidence bound above 0.5 against
UCT-16. It reduces *evaluation* search to fixed PUCT-1 and retains 32 distinct
nonterminal opening strata per task. The v2 configuration is a new protocol;
the v1 files above remain evidence of the abandoned pre-execution plan.
