# Terminal-only continuation training v4

This is a new, isolated continuation experiment. It starts from the four existing linear product parents (`easy`, `three-v4`, `three-v1`, `hex-v1`), preserving their exact parent hashes and initial logits. The original parent assets and the retired shallow-label protocols are unchanged. The existing two-player neural models are not retrained by this experiment.

The frozen recipe is `web/tools/configs/terminal-policy-v4-20261025.json`. Its target is 24 naturally completed canonical games per parent, 96 total, and at least four actual nonzero parameter updates per parent. A context-only game is not counted as a model update. Any truncated game prevents a successful training completion receipt. Truncated trajectories remain available with null terminal returns and no update.

## Environment reward and gradient samples

There is one environment reward, at natural game termination. Let `N=validPositions.length`, `Ai` be the learner's final native discrete territory-v3 area, and `Mi=Ai-max(opponents' final native areas)` over nonresigned opponents. The reward is:

`R = sign(Mi) + 0.1*Mi/N + 0.01*Ai/N`.

A sole win has outcome `1`, a tied top score `0`, and a loss `-1`. All nonterminal rewards are exactly zero. `gamma=1`; every eligible learner action receives the same final return `R`. There is no duration, early-win, intermediate-area, captured-line, or search-leaf reward. The optimizer uses the prior eligible-episode running baseline, fixed weights within an episode, clipped SGD and actual terminal REINFORCE log-probability gradients.

Every gradient sample must have a newly completed exact full-root Minimax analysis, including PASS, at actual depth `max(3,2*surviving seats)`. Reaching that depth in one partial branch is insufficient; all root values must be complete and exact. Searches that run out of budget, early-terminal searches that never reach the required actual depth, unselected states, and single-action masks supply no gradient.

At a complete analyzed state, the fixed defensive mask retains the lexicographically best tuple of teacher value entries `[0,1,4]`: initial-node retention, avoidance of repeated damaging replies, and initial-coverage retention. The full ten-dimensional teacher score is not used as the mask. All legal root values, including masked moves and PASS, remain in evidence. The learner samples its softmax within this theta-independent mask and computes its gradient with the same masked probabilities. Teacher leaf values remain analysis, never environment rewards.

Sampling turns are fixed before running, with separate schedules for the known cells. Learner seats rotate by the visit count of each cell, preventing a repeated cell from locking to one seat. State selection, completion budgets and ignored context-action gradients create selection/configuration bias; this recipe makes no general unbiased-policy-gradient theorem claim.

## Reliability before launch

Final-source checks passed after the frontend `20261025-terminal-v4` stamp and the cell-seat rotation fix:

- `node web/web前端/tests/verify-terminal-policy-v4.mjs`: natural-terminal formula, gamma one, nonzero real gradient, full-mask probabilities, orphan-step/update adoption, committed-step/update recovery, completion idempotence, PAUSE/duplicate exclusion, corrupt-checkpoint rejection, and truncated-no-return/no-update checks.
- `node web/web前端/tests/verify-terminal-policy-supervision-v4.mjs`: actual worker kill and automatic recovery, actual supervisor kill/restart, preserved committed step, identical recovered model, duplicate-supervisor rejection, and unchanged absolute deadline.

The compact receipts and final source/config/parent hashes are in `terminal-policy-v4-preflight.json`. Full local recovery fixtures are `local_artifacts/terminal-policy-v4-recovery-yQMbmR` and `local_artifacts/terminal-v4-supervisor-recovery-gA2Gyy`.

The real-kill exercise found and fixed an ownership race: the new worker had quarantined the supervisor's concurrently written temporary state file. Quarantine is now limited to the training worker's checkpoint/progress files. Fatal startup preserves prior progress and does not overwrite an invalid checkpoint. Committed trajectory steps are adopted without redoing their expensive analysis or RNG draw.

## Bounded cost observations

These are scout games preceding the final source freeze, not formal results or strength evidence. The first four-parent small-board pilot took 13.5 seconds total and made one real update for every parent; all four supplied opening samples. A representative broad-cell pilot used at most six fixed analyses with 2.5 seconds each:

| Cell | Natural plies | Wall seconds | Eligible samples | Actual updates |
| --- | ---: | ---: | ---: | ---: |
| 3p triangle7 | 32 | 8.4 | 0 | 0 |
| 3p triangle9 | 40 | 10.8 | 1 late | 1 |
| 4p hexagon5 | 113 | 15.8 | 0 | 0 |
| 5p hexagon5 | 92 | 12.3 | 0 | 0 |
| 6p hexagon5 | 89 | 10.2 | 0 | 0 |

The size9 sample was at ply33/learner-turn12, with complete actual depth6 and a three-action mask. No large-board opening or middle gradient is established by these pilots. Three further native-hex games with six better-distributed predetermined turns took 18.1, 15.4 and 17.7 seconds. They still supplied zero gradients: the 5p tail search produced one complete depth10 analysis with a singleton defensive mask, which correctly yielded no gradient. No search depth or action domain was reduced to obtain labels.

The formal budget is 3600 seconds, teacher budget 5 seconds/100000 nodes per selected state, and at most six analyses per game. Runtime cost and complete-search availability differ substantially by cell. Scheduled native-hex games alone do not prove native-hex training. If final native coverage is zero, the hex continuation is a candidate trained on the small triangular fallback and transferred to native boards; native strength requires separate matched full-game acceptance.

## Frozen run and completion boundary

The prepared run is `local_artifacts/terminal-policy-v4-formal-20261025-stamped`; its `job.json` binds the exact source, config and parent identities. Root owns the hidden independent supervisor and login recovery launch. The job has bounded retries, an original absolute deadline, exclusive worker/supervisor leases, and durable per-ply and per-episode receipts.

A read-only dependency review during the run found three transitive imports outside the worker's guarded source list: `MultiplayerClock.js`, and the unused ResearchAI/training-policy imports of the common file helper. Their observed hashes and the observation boundary are preserved separately in `terminal-policy-v4-supplemental-dependencies.json`. This supplements the evidence without changing the frozen run identity or claiming that its original guard covered these files.

Resume uses the same job; `PAUSE` or `STOP` in that run directory controls this job. Neither marker should be removed by recovery. Training dependencies must remain byte-identical during the run. Logs, complete trajectories, in-flight checkpoints and job trees remain local.

Candidate receipts are `models/{easy,three-v4,three-v1,hex-v1}/candidate.json`; closure is `completion-receipt.json`. Their `coverage` fields report actual cell/seat counts, complete and failed analysis counts, singleton masks, actual updates, and eligible samples split by realized native-game ply thirds. These thirds are a descriptive coverage measure, not a strategic-phase classifier.

The separate read-only review command is `node web/tools/review-terminal-policy-evidence-v4.mjs --run-root local_artifacts/terminal-policy-v4-formal-20261025-stamped`. It reconstructs canonical complete-state transitions, uses the official engine territory API to recompute terminal reward, verifies zero nonterminal rewards and identical undiscounted returns, and recomputes the masked softmax, running baseline, clipped gradient and parameter chain. It also checks the frozen and supplementary observed source hashes. `--allow-incomplete` produces explicitly partial accounting from committed episodes, without claiming formal completion.

`node web/web前端/tests/verify-terminal-evidence-review-v4.mjs` validates this reviewer with one newly generated tiny fixture and four deliberately corrupted copies. Incorrect terminal reward, discount, parameter update and defensive mask are rejected even after their outer integrity hashes are correctly recomputed. The compact receipt, exact reviewer/test hashes and local fixture location are in `terminal-policy-v4-review-negative-tests.json`; no formal-run file is changed by those checks. The reviewer audits the recorded search-completion evidence without rerunning every expensive teacher search.

A successful training receipt means the continuation ran under this recipe. Raw policy PASS behavior, natural-game strength, runtime admission, cross-platform integration and external release remain separate checks. This experiment must not be retuned mid-run to satisfy acceptance.

The raw 17-dimensional learner and the deployed AI are distinct objects. In particular, the three-v4 runtime keeps its original search algorithm and uses the continued 16 placement coefficients; it does not use the learned seventeenth PASS logit. Admission must test that actual search-plus-coefficients object with the shared opportunity guard disabled for its raw check, then test the real Worker route. A raw 17-dimensional opening-PASS failure remains a recorded diagnostic and must not be reported as a successful raw-learner check.

## Observed formal-run outcome

The 96 planned games all ended naturally, with zero truncations. The independent review in `terminal-policy-v4-final-review.json` passed complete-state replay, native terminal reward, nonterminal zeros, gamma one, eligible-return identity, recorded full-depth/root contracts, defensive masks, probabilities, baseline/gradient reconstruction and final parameter chains. Frozen and supplementary observed dependency hashes matched.

| Parent | Natural games | Actual nonzero updates | Eligible samples | Opening / middle / late samples |
| --- | ---: | ---: | ---: | --- |
| easy | 24 | 22 | 60 | 26 / 14 / 20 |
| three-v4 | 24 | 19 | 44 | 9 / 22 / 13 |
| three-v1 | 24 | 24 | 92 | 22 / 43 / 27 |
| hex-v1 | 24 | 3 | 4 | 4 / 0 / 0 |

The hex parent failed its frozen minimum of four actual updates. Its four eligible samples all came from 4p triangle5 openings; one had terminal reward exactly equal to the prior baseline, producing a genuine zero gradient. The 18 native-hex games supplied no gradient sample. One 4p native analysis completed but had a singleton mask; all other native analyses were incomplete. The three nonzero updates were in `hex-v1-seed3`, `hex-v1-seed19` and `hex-v1-seed23`; `seed7` was an optimizer step with unchanged weights.

Consequently the original run correctly ended `FATAL` on the minimum-update condition and produced no global completion receipt. The independent report is explicitly `PASS_PARTIAL_COMMITTED_EVIDENCE_ONLY`: all 96 committed games are audited, but the frozen training completion contract did not pass. This outcome is preserved. Any continuation must be a separately frozen extension/migration inheriting the actual learned weights and provenance; it must not lower the original threshold, rewrite counters or repeat the completed 96 games.
