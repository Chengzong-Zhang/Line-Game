// Short source-level integration checks on native legal-action prefixes.
// No server-game, strength, complete-multiplayer-round, bundle or latency claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { GameEngine } from '../GameEngine.js?v=20261025-unified1';
import { saveState } from '../AIEngine.js?v=20261025-unified1';
import { probeMultiplayerReplyResilience } from '../MultiplayerSearch.js?v=20261025-unified1';
import { compareCompletedReplyResilience } from '../MultiplayerHardValue.js?v=20261025-unified1';
import { createHardRuntimeV2, selectCompleteReplyResilience } from '../MultiplayerHardRuntime.js?v=20261025-unified1';
import { MultiplayerRolloutAI } from '../MultiplayerHardRollout.js?v=20261025-unified1';

const started = performance.now(), limitMs = 18000;
const guard = () => assert(performance.now() - started < limitMs, 'Short integration limit exceeded; no partial PASS');
const data = JSON.parse(await fs.readFile(new URL('./fixtures/multiplayer-cut-chain-defense-v1.json', import.meta.url), 'utf8'));
const policies = await Promise.all(['three-player-policy-v1', 'hex-player-policy-v1'].map(async name =>
  JSON.parse(await fs.readFile(new URL(`../assets/research-ai/${name}.json`, import.meta.url), 'utf8'))));
const key = point => point === null ? 'PASS' : point.join(',');
const players = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
function build(fixture, count) {
  const [boardShape, variant] = Object.entries(data.coordinateVariants).find(([, entry]) => entry.playerCounts.includes(count));
  const map = point => point === null ? null : point.map((value, axis) => value + variant.offset[axis]);
  const engine = new GameEngine({ playerCount: count, gridSize: variant.gridSize, boardShape,
    rulesVersion: data.rulesVersion, initialPositions: Object.fromEntries(players.slice(0, count).map(player =>
      [player, variant.initialPositions[player]])), deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  const act = point => { guard(); const result = point === null ? engine.skipTurn() : engine.playMove(point);
    assert(result.success, `${fixture.id}/${count}: ${JSON.stringify(point)} ${result.reason}`); };
  fixture.prefix.forEach((point, index) => {
    assert.equal(engine.currentPlayer, index % 2 ? 'WHITE' : 'BLACK'); act(map(point));
    if (index % 2) {
      let skips = 0;
      while (!engine.gameOver && engine.currentPlayer !== 'BLACK') { assert(skips++ < count); act(null); }
    }
  });
  assert.equal(engine.currentPlayer, 'BLACK'); assert.equal(engine.gameOver, false);
  return { engine, candidate: map(fixture.candidate), alternative: map(fixture.alternative) };
}
const complete = (engine, point) => {
  guard();
  const packet = probeMultiplayerReplyResilience(engine, point, {
    maxReplies: engine.validPositions.length + 1, maxProbes: 16384, timeMs: 1000 });
  assert.equal(packet.reason, 'complete', JSON.stringify(packet));
  compareCompletedReplyResilience(packet, packet);
  return packet;
};
const rows = [];
let controlledSource, shouldNotPassEvidence;
for (const count of [3, 4, 5, 6]) for (const fixture of data.fixtures) {
  const { engine, candidate, alternative } = build(fixture, count);
  const before = saveState(engine), refs = [engine.grid, engine.edges, engine.historyHashes];
  const native = engine.getLegalMoves().map(move => key(move.point));
  assert(native.includes(key(candidate))); assert(native.includes(key(alternative)));
  const safe = complete(engine, candidate), exposed = complete(engine, alternative);
  if (count === 3) {
    for (const followupMode of ['minimum', 'none']) {
      const packet = probeMultiplayerReplyResilience(engine, candidate, { followupMode,
        maxReplies: engine.validPositions.length + 1, maxProbes: 16384, timeMs: 1000 });
      assert.equal(packet.reason, 'complete');
      for (const field of ['repliesCompleted', 'maximumNodeLoss', 'maximumCoverageLoss',
        'minimumRetainedCapturedNodes', 'worstNetNodeGain', 'minimumDefenseSignal', 'allRepliesRetainAttackNode'])
        assert.equal(packet[field], safe[field], `${followupMode}/${field} disagrees with complete reference`);
      if (followupMode === 'minimum') {
        assert.equal(packet.minimumFollowupCutNodes, safe.minimumFollowupCutNodes);
        assert.equal(packet.allRepliesRetainFollowupCut, safe.allRepliesRetainFollowupCut);
      } else {
        assert.equal(packet.conditionalFollowupComplete, false);
        assert.equal(packet.minimumFollowupCutNodes, null); assert.equal(packet.allRepliesRetainFollowupCut, null);
        assert.equal(packet.signal, null);
      }
    }
  }
  assert.equal(safe.maximumNodeLoss, fixture.expected.candidateMaxNodeLoss);
  assert.equal(safe.maximumCoverageLoss, fixture.expected.candidateMaxCoverageLoss);
  if (fixture.kind !== 'chain') {
    assert.equal(exposed.maximumNodeLoss, fixture.expected.alternativeMaxNodeLoss);
    assert.equal(exposed.maximumCoverageLoss, fixture.expected.alternativeMaxCoverageLoss);
    assert(compareCompletedReplyResilience(safe, exposed) > 0);
  } else {
    assert.equal(safe.allRepliesRetainFollowupCut, true);
    assert(safe.minimumFollowupCutNodes >= fixture.expected.minimumSecondCutNodeCapture);
    // The safe immediate two-node alternative forbids a unique-best claim.
  }
  const policySpec = policies[count === 3 ? 0 : 1];
  const runtime = createHardRuntimeV2(engine, { policySpec, modelInfo: { id: policySpec.id } });
  const result = runtime.ai.getTopMoves(engine, 'BLACK', 5), stats = runtime.ai.lastSearch;
  assert(result.length > 0);
  const full = runtime.ai.fallbackPolicy.fullRanking;
  assert(full?.some(move => key(move.point) === key(candidate)), 'repair/chain candidate in actual complete root ranking');
  assert(full?.some(move => key(move.point) === key(alternative)), 'alternative in actual complete root ranking');
  const tactical = stats.tacticalSearch;
  assert(tactical?.candidateReachability.some(move => key(move.point) === key(candidate)));
  assert(tactical.candidateReachability.some(move => key(move.point) === key(alternative)));
  const passReachability = tactical.candidateReachability.find(move => move.point === null);
  assert(passReachability, 'native PASS remains in the complete root domain');
  assert(passReachability.visitOrder <= 2, `PASS was not reachable early: ${JSON.stringify(passReachability)}`);
  if (tactical.accepted) {
    assert.equal(stats.selectedEvaluation, 'complete-next-opponent-resilience');
    assert.equal(key(result[0].point), key(tactical.selected.point));
    assert(tactical.completedRoots.some(row => key(row.point) === key(result[0].point)));
    assert.equal(new Set(result.map(move => key(move.point))).size, result.length);
    assert.equal(result.length, Math.min(5, new Set([key(result[0].point), ...full.slice(0, 5).map(move => key(move.point))]).size));
    assert(compareCompletedReplyResilience(complete(engine, result[0].point),
      complete(engine, tactical.anchor.point)) > 0);
  }
  if (fixture.kind !== 'chain') {
    const chosen = complete(engine, result[0].point);
    assert.equal(chosen.maximumNodeLoss, 0, `${count}/${fixture.id}: unsafe selected root ${JSON.stringify({ result, tactical })}`);
  }
  if (count === 4 && fixture.id === 'one-node-capture-loses-two-to-countercut') {
    const pass = complete(engine, null);
    assert(compareCompletedReplyResilience(safe, pass) > 0,
      'PASS must not replace a complete zero-loss repair with equal-or-better net material');
    assert.notEqual(result[0].point, null);
    shouldNotPassEvidence = { prefix: fixture.id, selected: result[0].point,
      move: { maximumNodeLoss: safe.maximumNodeLoss, maximumCoverageLoss: safe.maximumCoverageLoss,
        worstNetNodeGain: safe.worstNetNodeGain },
      pass: { maximumNodeLoss: pass.maximumNodeLoss, maximumCoverageLoss: pass.maximumCoverageLoss,
        worstNetNodeGain: pass.worstNetNodeGain }, passVisitOrder: passReachability.visitOrder };
  }
  assert.deepEqual(saveState(engine), before); assert.equal(engine.grid, refs[0]);
  assert.equal(engine.edges, refs[1]); assert.equal(engine.historyHashes, refs[2]);
  assert.equal(runtime.modelInfo.implementationId, 'multiplayer-hard-cut-resilience-v1');
  assert.equal(runtime.modelInfo.absoluteDeadlineMs, 650);
  rows.push({ count, fixture: fixture.id, candidate, alternative,
    candidateRank: full.findIndex(move => key(move.point) === key(candidate)),
    alternativeRank: full.findIndex(move => key(move.point) === key(alternative)),
    selected: result[0].point, decision: stats.decisionSource, elapsedMs: stats.elapsedMs,
    attempted: tactical.attemptedRoots.length, completed: tactical.completedRoots.length,
    accepted: tactical.accepted, reason: tactical.reason,
    candidateAttempted: tactical.attemptedRoots.some(row => key(row.point) === key(candidate)),
    candidateComplete: tactical.completedRoots.some(row => key(row.point) === key(candidate)),
    candidateLoss: safe.maximumNodeLoss, alternativeLoss: exposed.maximumNodeLoss,
    minimumConditionalSecondCut: safe.minimumFollowupCutNodes });
  if (count === 3 && fixture.kind === 'defense') controlledSource = { engine, policySpec, candidate, alternative };
}

// A compact native prefix where making the only placement exposes one unit of
// coverage, while PASS preserves all current nodes and coverage against every
// legal reply by the actual next player. The full two-root domain completes;
// this is a real strategic PASS, not a deadline or no-legal-move fallback.
const passPrefix = [[0,2], [2,2], [3,1], [1,2], [2,1], [2,0]];
const passSource = new GameEngine({ playerCount: 3, gridSize: 5, rulesVersion: 'territory-v3',
  deferTerritoryUpdates: true });
passSource._isReplayingBatch = true;
for (const [index, point] of passPrefix.entries()) {
  assert.equal(passSource.currentPlayer, players[index % 3]);
  assert(passSource.playMove(point).success);
}
assert.equal(passSource.currentPlayer, 'BLACK'); assert.equal(passSource.gameOver, false);
const passBefore = saveState(passSource), passPolicy = policies[0];
const passRuntime = createHardRuntimeV2(passSource, { policySpec: passPolicy, modelInfo: { id: passPolicy.id } });
const passMoves = passRuntime.ai.getTopMoves(passSource, 'BLACK', 5);
assert.equal(passMoves[0].point, null, JSON.stringify(passRuntime.ai.lastSearch));
assert.equal(passMoves[0].type, 'pass');
assert.equal(new Set(passMoves.map(move => key(move.point))).size, passMoves.length,
  'strategic PASS publication must not duplicate a fallback root');
const expectedPassTopN = [{ point: null }, ...passRuntime.ai.fallbackPolicy.fullRanking]
  .filter((move, index, moves) => moves.findIndex(candidate => key(candidate.point) === key(move.point)) === index)
  .slice(0, 5).map(move => key(move.point));
assert.deepEqual(passMoves.map(move => key(move.point)), expectedPassTopN,
  'strategic PASS must preserve a complete deduplicated top-N fallback tail');
assert.equal(passRuntime.ai.lastSearch.selectedEvaluation, 'complete-next-opponent-resilience');
assert.equal(passRuntime.ai.lastSearch.tacticalSearch.completeRootDomain, true);
assert.equal(passRuntime.ai.lastSearch.tacticalSearch.candidateReachability.find(move => move.point === null).visitOrder, 1);
const onlyMove = passRuntime.ai.fallbackPolicy.fullRanking[0].point;
assert.deepEqual(onlyMove, [1,0]);
const onlyMovePacket = complete(passSource, onlyMove), strategicPassPacket = complete(passSource, null);
assert(compareCompletedReplyResilience(strategicPassPacket, onlyMovePacket, { anchor: onlyMovePacket }) > 0);
assert.equal(onlyMovePacket.maximumNodeLoss, 0); assert.equal(onlyMovePacket.maximumCoverageLoss, 1);
assert.equal(strategicPassPacket.maximumNodeLoss, 0); assert.equal(strategicPassPacket.maximumCoverageLoss, 0);
assert.deepEqual(saveState(passSource), passBefore);
assert(shouldNotPassEvidence, 'paired native non-PASS evidence was not exercised');
const shouldPassEvidence = { prefix: passPrefix, selected: null, completeRootDomain: true,
  move: { point: onlyMove, maximumNodeLoss: onlyMovePacket.maximumNodeLoss,
    maximumCoverageLoss: onlyMovePacket.maximumCoverageLoss, worstNetNodeGain: onlyMovePacket.worstNetNodeGain },
  pass: { maximumNodeLoss: strategicPassPacket.maximumNodeLoss,
    maximumCoverageLoss: strategicPassPacket.maximumCoverageLoss,
    worstNetNodeGain: strategicPassPacket.worstNetNodeGain }, passVisitOrder: 1 };

// Control-flow fixtures test publication only; these synthetic packets make no
// claim about the native geometry. Real integration above uses only native probes.
const { engine, candidate, alternative, policySpec } = controlledSource;
const roots = [{ point: alternative }, { point: candidate }, { point: null }];
const packet = (point, loss, overrides = {}) => ({ complete: true, reason: 'complete', terminalRoot: false,
  player: engine.currentPlayer, rootPoint: point, replyPlayer: 'WHITE', repliesCompleted: 7, probes: 10,
  maximumNodeLoss: loss, maximumCoverageLoss: 0, rootWasAttack: true,
  allRepliesRetainAttackNode: true, minimumFollowupCutNodes: 0, allRepliesRetainFollowupCut: false,
  conditionalFollowupComplete: true,
  minimumRetainedCapturedNodes: 0, worstNetNodeGain: -loss, minimumDefenseSignal: .1, ...overrides });

// A normal empty-point anchor still needs a direct-risk row because tactical
// roots are compared against that fixed anchor. Previously the terminal scan
// skipped its row and the comparison dereferenced undefined, disabling this
// entire layer for ordinary-placement incumbents.
const placementAnchor = { point: [4,0] };
const placementFullRanking = engine.getLegalMoves().map(move => ({ point: move.point }));
assert(placementFullRanking.some(move => key(move.point) === key(placementAnchor.point)),
  'placement-anchor regression requires a native legal empty point');
const placementAnchorResult = selectCompleteReplyResilience(engine, {
  anchor: placementAnchor,
  fullRanking: placementFullRanking,
  deadline: performance.now() + 1000,
  windowMs: 1000,
});
assert.notEqual(placementAnchorResult.stats.reason, 'error', JSON.stringify(placementAnchorResult.stats));
const placementAnchorReachability = placementAnchorResult.stats.candidateReachability
  .find(move => key(move.point) === key(placementAnchor.point));
assert(placementAnchorReachability?.directCutRisk,
  'fixed placement anchor must retain a complete direct-cut risk row');
assert.equal(key(placementAnchorResult.moves?.[0]?.point), key(candidate),
  'native placement-anchor regression must still reach the zero-loss repair');
let clock = 0, calls = 0;
const bestAtDeadline = selectCompleteReplyResilience(engine, { anchor: roots[0], fullRanking: roots,
  deadline: 100, now: () => clock, probe: (_source, point) => {
    calls++;
    if (calls === 3) { clock = 100; return { ...packet(point, 0), complete: false, reason: 'deadline' }; }
    return packet(point, calls === 1 ? 3 : 1);
  } });
assert.equal(bestAtDeadline.stats.accepted, true); assert.equal(key(bestAtDeadline.moves[0].point), key(candidate));
assert.equal(bestAtDeadline.stats.completedRoots.length, 2); assert.equal(bestAtDeadline.stats.partialRootDiscarded, true);
calls = 0;
const bestNotFirst = selectCompleteReplyResilience(engine, { anchor: roots[0], fullRanking: roots,
  deadline: 100, now: () => 0, probe: (_source, point) => packet(point, [3, 2, 0][calls++]) });
assert.equal(bestNotFirst.moves[0].point, null); assert.equal(bestNotFirst.stats.completedRoots.length, 3);
for (const badProbe of [
  (_source, point) => ({ ...packet(point, 0), complete: false, reason: 'probe-limit' }),
  () => { throw new Error('controlled probe exception'); },
  (_source, point) => ({ ...packet(point, 0), maximumNodeLoss: NaN }),
  (_source, point) => ({ ...packet(point, 0), terminalRoot: true, reason: 'terminal-root' }),
]) {
  const rejected = selectCompleteReplyResilience(engine, { anchor: roots[0], fullRanking: roots,
    deadline: 100, now: () => 0, probe: badProbe });
  assert.equal(rejected.moves, null); assert.equal(rejected.stats.accepted, false);
}
assert.equal(compareCompletedReplyResilience(packet(candidate, 0, { minimumDefenseSignal: 1000 }),
  packet(alternative, 0, { minimumDefenseSignal: -1000 })), 0, 'float gain alone never replaces anchor');
assert(compareCompletedReplyResilience(packet(candidate, 0, { minimumFollowupCutNodes: 1, allRepliesRetainFollowupCut: true }),
  packet(alternative, 0)) > 0);
assert.throws(() => compareCompletedReplyResilience(packet(candidate, 0,
  { minimumFollowupCutNodes: 1, allRepliesRetainFollowupCut: false }), packet(alternative, 0)));
assert.equal(compareCompletedReplyResilience(packet(candidate, 0,
  { minimumFollowupCutNodes: 2, allRepliesRetainFollowupCut: true }), packet(alternative, 0,
  { minimumFollowupCutNodes: null, allRepliesRetainFollowupCut: null, conditionalFollowupComplete: false })), 0,
'unknown incumbent followup cannot be treated as zero');
assert(compareCompletedReplyResilience(packet(candidate, 0, { minimumRetainedCapturedNodes: 1, worstNetNodeGain: 1,
  minimumFollowupCutNodes: 3, allRepliesRetainFollowupCut: true }),
packet(alternative, 0, { minimumRetainedCapturedNodes: 2, worstNetNodeGain: 2 })) < 0,
'safe immediate two-node capture cannot be displaced by a one-node conditional chain');
assert.equal(compareCompletedReplyResilience(packet(candidate, 0),
  packet(alternative, 1, { minimumRetainedCapturedNodes: 3, worstNetNodeGain: 2 })), 0,
'lower own-node loss cannot reduce guaranteed net nodes from the fixed anchor');
for (const preflightResult of [
  { complete: false, terminalRoot: null, attemptedRoots: 1, reason: 'deadline' },
  { complete: false, terminalRoot: { point: null }, attemptedRoots: 3, reason: 'terminal-requires-native-score' },
]) {
  const result = selectCompleteReplyResilience(engine, { anchor: roots[0], fullRanking: roots,
    deadline: 100, now: () => 0, preflight: () => preflightResult,
    probe: () => { throw new Error('probe ran before complete terminal preflight'); } });
  assert.equal(result.moves, null); assert.equal(result.stats.attemptedRoots.length, 0);
  assert.equal(result.stats.reason, preflightResult.reason);
}
const terminalSource = new GameEngine({ playerCount: 3, gridSize: 5, rulesVersion: 'territory-v3', deferTerritoryUpdates: true });
terminalSource._isReplayingBatch = true;
assert(terminalSource.skipTurn().success); assert(terminalSource.skipTurn().success);
const terminalBefore = saveState(terminalSource), terminalRoots = terminalSource.getLegalMoves();
assert(terminalRoots.length >= 2);
const nativeTerminalGuard = selectCompleteReplyResilience(terminalSource, { anchor: terminalRoots[0], fullRanking: terminalRoots,
  deadline: performance.now() + 500, windowMs: 500,
  probe: () => { throw new Error('topology probe masked late native terminal PASS'); } });
assert.equal(nativeTerminalGuard.moves, null);
assert.equal(nativeTerminalGuard.stats.reason, 'terminal-requires-native-score');
assert.equal(nativeTerminalGuard.stats.terminalPreflight.terminalRoot.point, null);
assert.equal(nativeTerminalGuard.stats.attemptedRoots.length, 0);
assert.deepEqual(saveState(terminalSource), terminalBefore);

// The accepted tactical packet must bypass the old single-policy rollout.
const original = MultiplayerRolloutAI.prototype.getTopMoves;
try {
  MultiplayerRolloutAI.prototype.getTopMoves = () => { throw new Error('accepted packet overwritten by rollout'); };
  const runtime = createHardRuntimeV2(engine, { policySpec, modelInfo: { id: policySpec.id } });
  runtime.ai.getTopMoves(engine, 'BLACK', 5);
  assert.equal(runtime.ai.lastSearch.tacticalSearch.accepted, true);
} finally { MultiplayerRolloutAI.prototype.getTopMoves = original; }
guard();
console.log(JSON.stringify({ status: 'PASS', scope: 'native-legal-prefix-short-source-regression',
  noStrengthOrUniversalLatencyClaim: true, sourceOnlyNoBundleClaim: true, rows,
  passDecisions: { shouldPass: shouldPassEvidence, shouldNotPass: shouldNotPassEvidence },
  publicationControls: ['best-completed-retained-at-deadline', 'best-not-first', 'incomplete-exception-invalid-terminal-fail-closed',
    'integer-loss-lexicographic-order', 'all-replies-chain-gate', 'native-strategic-pass-pair',
    'accepted-packet-bypasses-rollout'],
  elapsedMs: performance.now() - started }, null, 2));
