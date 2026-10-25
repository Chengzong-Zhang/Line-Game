# PASS discipline task acceptance

This protocol qualifies the requested opening/terminal PASS correction in a bounded product scope. It never upgrades global strength verification or Ultimate model admission. Baseline is the immutable `defense-15-players` checkout; candidate is the isolated `pass-discipline` checkout with four newly trained native linear parents. The 17 neural model weights remain unchanged.

## Training reward and eligibility

Use only a natural native-engine terminal reward, with `N = validPositions.length`, terminal discrete area `A_i`, margin `M_i = A_i - max(nonresigned opponent areas)`, and `R_i = sign(M_i) + 0.1 M_i/N + 0.01 A_i/N`. A resigned player's outcome is −1; an empty surviving-opponent maximum is 0. Every nonterminal reward is exactly 0 and `gamma = 1`. All eligible learner time indices receive that same undiscounted terminal return. A truncated/incomplete episode has no terminal reward or update. No duration, early-win or intermediate-area reward is permitted.

Only newly completed exact full-legal-root Minimax analyses, including PASS, are gradient eligible. Required and actually reached depth is at least `max(3, 2 * surviving seats)`. Other steps remain behavior context only. The finite-horizon native-area teacher is auxiliary eligibility/defense analysis, never evidence of a terminal environment reward. Gamma 1 does not prove global perfect play or remove finite-depth limitations.

The independent verifier must replay every persisted training transition, check complete labels against the legal root set, derive terminal reward from final native areas, reconstruct masked probabilities and the REINFORCE update, and bind candidates to checkpoint, episode, parent, config and source hashes. A schema name or claimed update count alone is insufficient.

## Fresh complete games

The frozen machine-readable protocol is `web/tools/configs/pass-discipline-acceptance-v1-20261025.json`. Four cells are used: easy at 3-player triangle size 7; three-v4 at 3-player triangle size 7; three-v1 at the actual fallback route, 3-player triangle size 6; hex-v1 at 4-player hexagon size 5. Each has two deterministic custom starting layouts at ply 0, with roots separated by axial distance at least 3 and at least two legal opening moves per seat. The earlier size-5 easy cost pilot ended naturally in three placements, despite four legal opening choices per seat. That fresh but short pilot is retained as cost evidence only; its weak behavioral information motivated the size-7 full-game cell. Size 5 remains in snapshot coverage.

For each layout run one all-baseline control and one replacement game for each focal seat. This gives 34 games and eight layout blocks. Candidate and control share identical complete starting state; no random action prefix or near-terminal seeded board is used. Seat outcomes within one layout are dependent. Paired win share is a diagnostic with its denominator, not a population win-rate or strength proof.

Every actual candidate Worker decision must identify the exact trained candidate SHA-256. Persist each action and complete rule/history/edge/actor state before the next decision. Termination uses native engine rules and discrete area. A 600-ply cutoff produces an explicitly truncated record and cannot count toward the required 34 natural complete games.

## Independent PASS opportunity checks

The oracle is separate from the runtime guard. It replays the canonical GameEngine and requires a profitable expansion retaining old/new pieces and initial-node connectivity throughout every legal/PASS continuation in one complete actual opponent round. Budget exhaustion yields incomplete evidence. An auto-skip cannot shorten that window at a repeated opponent actor. A separate structural proof may certify a root whose entire friendly line coverage lies in the initial node's protected adjacency and whose rooted occupied-point lower bound exceeds the original native area; this proof is reported explicitly.

The three-seat counterexample is BLACK `[0,0]`, WHITE `[6,0]`, PURPLE `[3,3]` on triangle size 7. BLACK `[0,4]` survives every immediate WHITE response but PURPLE `[0,3]` can cut it after WHITE acts, reducing BLACK from area 5 to area 1. The three-v1 fallback uses the independently checked size-6 version with WHITE `[5,0]` and PURPLE `[2,3]`; this preserves its actual model route and exact candidate-hash check. A next-opponent-only certificate must not qualify either root.

Each trained parent is checked raw and through the actual Worker at opening and winning-terminal-PASS-with-safe-growth states. Native parent routes cover sizes 5/7/9; the three-v1 fallback is checked at size 6. Shared snapshots additionally cover 2-player Greedy/Minimax/MCTS, the five legacy model-free families, three neural-PUCT families, 3–6-player easy/medium/hard, generic hard at every count 7–15, and a genuine forced 15-player PASS. Reduced snapshot search budgets are recorded in the config. These are Node entry-source checks, not browser/Canvas/WeChat/device verification. Size 9 has no full-game qualification in this protocol.

## Reliability, budget and admission

Before the campaign, run deterministic checkpoint/resume, pre-index receipt adoption, duplicate exclusion, pause/stop, interrupted-write preservation and corruption-refusal tests. First measure a natural size-5 and size-7 baseline game. Run formal work under independent bounded supervision, with per-action checkpoints, run-root locks, source/config/candidate identities, progress/exit logs, PAUSE/STOP and login recovery. Total campaign budget is 25 minutes; worker segments are at most 60 seconds. Budget exhaustion preserves evidence and leaves admission pending.

Grant only `PASS_DISCIPLINE_SCOPED` after all four actual trained candidates, raw/runtime scenarios, shared boundary cases, 34 fresh natural games, zero independently certified bad candidate PASS choices, and the independent terminal-reward/training audit pass. Report unresolved budget/incomplete opportunity checks and measured latencies. Keep `strength_verified:false`; no universal safety or global strength claim follows.

Install an evaluation-only overlay before freezing actual Worker sources. After admission, retain exact before/after bytes if activation metadata or report hashes change. All weights, routing and guard code must remain identical. Recheck four parents' opening and terminal-growth decisions against the final activation, with hash binding; a functional source change requires affected-scope reevaluation. Browser, server activation, Mini upload, device, experience and public release have separate receipts.
