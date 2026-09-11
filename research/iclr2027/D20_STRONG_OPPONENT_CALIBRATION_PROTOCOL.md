# D20 strong-opponent calibration: Minimax-d2-cap8 versus UCT-16

Protocol ID: `d20_strong_opponent_calibration_protocol_20260909_v1`  
Experiment ID: `d20_strong_opponent_calibration_minimax_d2_cap8_vs_uct16_v1`  
Status: formal local execution authorized.

## Purpose and boundary

This is an append-only gate for D20-v2, not an ablation result and not a
replacement for the frozen D19-v2 protocol.  It tests one pre-registered
candidate opponent, `minimax_d2_cap8_v1`, against the pre-existing
`uct_mcts_s16_d80_v1` baseline.  The candidate uses alpha-beta Minimax with
depth two, tactical point-move cap eight, PASS as an extra branch, and the
repository's frozen heuristic.  The reference uses UCT with 16 simulations,
rollout depth 80, and exploration `sqrt(2)`.

The candidate is not called strong based on its implementation or on an
unregistered screening result.  It becomes eligible only if this protocol
passes at both required sizes.  A failure or an inconclusive result stops
D20-v2; no replacement candidate may be selected from this run.

## Registered arena

The arena uses exact LIFELINE rules with Superko `enforce`, BLACK as the
initial player, and at most 256 total plies per game.  Sizes are `10` and
`12`.  Each size has five fixed RNG blocks.  Each block contains four
deterministically generated, nonterminal rule-engine openings; no model,
trajectory, or prior result is consulted by the opening generator.

For every opening, the candidate and reference play twice with the same
identity-bound policy seeds: once with the candidate as BLACK and once as
WHITE.  Thus each size has `5 * 4 * 2 = 40` games and the complete calibration
has 80 games.  The raw records retain every opening prefix, colour assignment,
policy seed, action, pre-action state fingerprint, terminal territory, and
row hash.  Any truncation, illegal replay, missing pair, duplicate opening, or
source/manifest drift fails closed.

## Registered decision rule

For each size, a block score is the mean candidate score across its eight
colour-balanced games, with win/draw/loss scores `1/0.5/0`.  The five block
means are the only primary samples.  Let `m` be their mean and `s` their
sample standard deviation.  The two-sided Student-t 95% interval is

`m ± 2.7764451051977987 * s / sqrt(5)`.

The candidate passes a size only if the lower endpoint is strictly greater
than `0.5`, all 40 games terminate without truncation, and independent replay
passes.  The whole calibration has `status=PASS` and `formal_ready=true` only
when both n=10 and n=12 pass.  Pooled game counts are descriptive and are not
treated as independent inferential samples.

## Evidence and use

The executor writes all raw local artifacts under
`local_artifacts/d20_strong_opponent_calibration/`.  A separate verifier does
not import the executor; it reconstructs the fixed plan and openings,
replays every game, recomputes five-block intervals, and checks the canonical
aggregate.  Only its PASS report may be supplied to D20-v2 via
`--calibration-report`.

Passing establishes only that this one fixed Minimax configuration exceeded
this one fixed UCT-16 baseline under this registered small arena.  It does not
make the comparison compute-matched, establish a universal ordering of search
algorithms, validate D19-v2's same-observation-and-mask construct, or by
itself establish an ICLR-ready paper.
