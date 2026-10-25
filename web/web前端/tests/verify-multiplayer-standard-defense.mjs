import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { saveState } from "../AIEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";
import { probeMultiplayerReplyResilience } from "../MultiplayerSearch.js?v=20261025-room1";
import { applyStandardDefenseGate, STANDARD_DEFENSE_GATE,
  strictlyImprovesStandardDefense } from "../MultiplayerStandardDefense.js?v=20261025-room1";

const originalFetch = globalThis.fetch;
globalThis.fetch = async input => new Response(await readFile(fileURLToPath(input instanceof URL ? input : new URL(input))));

const fixtureData = JSON.parse(await readFile(new URL("./fixtures/multiplayer-cut-chain-defense-v1.json", import.meta.url), "utf8"));
const players = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
const pointKey = point => point === null ? "PASS" : point.join(",");
const samePoint = (left, right) => pointKey(left) === pointKey(right);

function packet(point, maximumNodeLoss, maximumCoverageLoss, minimumRetainedCapturedNodes, overrides = {}) {
  return { complete: true, reason: "complete", terminalRoot: false, player: "BLACK", replyPlayer: "WHITE",
    rootPoint: [...point], repliesCompleted: 1, followupMode: "none", maximumNodeLoss, maximumCoverageLoss,
    minimumRetainedCapturedNodes, ...overrides };
}

function pureGateChecks() {
  const source = { gameOver: false, currentPlayer: "BLACK", activePlayers: ["BLACK", "WHITE", "PURPLE"],
    resignedPlayers: new Set(["PURPLE"]), validPositions: Array.from({ length: 20 }) };
  const original = [[0,0],[1,0],[2,0],[3,0]].map((point, index) => ({ point, score: 10-index, prior: .4-index*.05, visits: index+1 }));
  const featureRow = (ownCoverage, relativeReach = 0) => Array.from({ length: 16 }, (_, feature) =>
    feature === 10 || feature === 6 ? 1 : feature === 9 ? ownCoverage : feature === 5 ? relativeReach : 0);
  original[0].features = featureRow(1, 1);
  const repairs = [[4,0],[5,0],[6,0],[7,0],[8,0]].map((point, index) => ({ point, score: -index, prior: .01,
    visits: 1, features: featureRow(index === 0 ? 3 : 2, index === 0 ? 2 : 1) }));
  const packets = new Map([
    ["0,0", packet([0,0], 4, 13, 1)], ["1,0", packet([1,0], 3, 13, 1)],
    ["2,0", packet([2,0], 4, 12, 0)], ["3,0", packet([3,0], 5, 10, 2)],
    ["4,0", packet([4,0], 0, 0, 1)], ["5,0", packet([5,0], 4, 13, 1)],
    ["6,0", packet([6,0], 4, 13, 1)], ["7,0", packet([7,0], 0, 0, 1)],
    ["8,0", packet([8,0], 0, 0, 2)],
  ]);
  const calls = [];
  const selected = applyStandardDefenseGate(source, original, { completeRanking: [original[0], ...repairs], startedAt: 0, now: () => 0,
    probe: (_source, point, options) => {
      calls.push(pointKey(point));
      assert.equal(options.maxReplies, source.validPositions.length + 1);
      assert.equal(options.maxProbes, 4096); assert.equal(options.timeMs, 60);
      assert.equal(options.deadline, 60); assert.equal(options.followupMode, "none");
      return packets.get(pointKey(point));
    } });
  assert.equal(selected.receipt.status, "selected-strict-defense-improvement");
  assert.deepEqual(calls, ["0,0","4,0"]);
  assert.equal(selected.moves[0], repairs[0], "Promoted repair must preserve the original complete-ranking object");
  assert.deepEqual(selected.moves.slice(1), original.slice(0, 3), "Remaining roots keep their original order");
  assert.equal(selected.moves.length, original.length); assert.equal(calls.length, STANDARD_DEFENSE_GATE.maximumRoots);

  const anchor = packet([0,0], 2, 5, 1);
  assert.equal(strictlyImprovesStandardDefense(anchor, packet([1,0], 1, 5, 1)), true);
  assert.equal(strictlyImprovesStandardDefense(anchor, packet([1,0], 2, 5, 1)), false, "ties preserve policy");
  assert.equal(strictlyImprovesStandardDefense(anchor, packet([1,0], 1, 6, 1)), false, "coverage regression rejects");
  assert.equal(strictlyImprovesStandardDefense(anchor, packet([1,0], 1, 5, 0)), false, "capture regression rejects");

  const fallbackCases = [
    packet([0,0], 2, 5, 1, { complete: false, reason: "probe-limit" }),
    packet([0,0], 2, 5, 1, { complete: false, reason: "reply-limit" }),
    packet([0,0], 2, 5, 1, { complete: false, reason: "deadline" }),
    packet([0,0], 2, 5, 1, { terminalRoot: true, reason: "terminal-root" }),
    packet([0,0], 2, 5, 1, { player: "WHITE" }),
    packet([0,0], 2, 5, 1, { replyPlayer: "BLACK" }),
    packet([0,0], 2, 5, 1, { replyPlayer: "PURPLE" }),
    packet([0,0], 2, 5, 1, { repliesCompleted: undefined }),
    packet([0,0], 2, 5, 1, { repliesCompleted: 0 }),
    packet([0,0], 2, 5, 1, { repliesCompleted: 1.5 }),
    packet([0,0], 2.5, 5, 1),
    packet([0,0], 2, 5.5, 1),
    packet([0,0], 2, 5, 1.5),
    packet([9,9], 2, 5, 1),
  ];
  for (const bad of fallbackCases) {
    const result = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0, now: () => 0,
      probe: () => bad });
    assert.equal(result.moves, original, `Invalid packet must preserve original ranking: ${bad.reason}`);
    assert.equal(result.receipt.status, "preserved-anchor-packet",
      `Invalid anchor packet must be rejected before any challenger: ${JSON.stringify(bad)}`);
  }
  const incompleteChallenger = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0, now: () => 0,
    probe: (_source, point) => samePoint(point, original[0].point) ? anchor
      : packet(point, 0, 0, 1, { complete: false, reason: "probe-limit" }) });
  assert.equal(incompleteChallenger.moves, original);
  const emptyReplyChallenger = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0, now: () => 0,
    probe: (_source, point) => samePoint(point, original[0].point) ? anchor
      : packet(point, 0, 0, 1, { repliesCompleted: 0 }) });
  assert.equal(emptyReplyChallenger.moves, original);
  const thrown = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0, now: () => 0,
    probe: () => { throw new Error("controlled"); } });
  assert.equal(thrown.moves, original);
  const clock = [0, 61];
  const expired = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0, now: () => clock.shift() ?? 61,
    probe: (_source, point) => packet(point, 2, 5, 1) });
  assert.equal(expired.moves, original); assert.equal(expired.receipt.status, "preserved-deadline");
  const lateClock = [0, 0, 0, 61];
  const lateCompleteChallenger = applyStandardDefenseGate(source, original, { completeRanking: [original[0], repairs[0]], startedAt: 0,
    now: () => lateClock.shift() ?? 61, probe: (_source, point) => packet(point, 0, 0, 1) });
  assert.equal(lateCompleteChallenger.moves, original);
  assert.equal(lateCompleteChallenger.receipt.status, "preserved-deadline");
}

function variantFor(count) {
  return Object.values(fixtureData.coordinateVariants).find(variant => variant.playerCounts.includes(count));
}
function translate(point, variant) {
  return point === null ? null : point.map((coordinate, index) => coordinate + variant.offset[index]);
}
function createEngine(count, rulesVersion) {
  const variant = variantFor(count);
  const engine = new GameEngine({ gridSize: variant.gridSize, playerCount: count,
    boardShape: count === 3 ? "triangle" : "hexagon", rulesVersion,
    initialPositions: Object.fromEntries(players.slice(0, count).map(player => [player, variant.initialPositions[player]])),
    deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  return engine;
}
function act(engine, point) {
  const result = point === null ? engine.skipTurn() : engine.playMove(point);
  assert.equal(result.success, true, result.reason);
}
function buildFixture(fixture, count, rulesVersion) {
  const engine = createEngine(count, rulesVersion), variant = variantFor(count);
  fixture.prefix.forEach((point, index) => {
    assert.equal(engine.currentPlayer, index % 2 ? "WHITE" : "BLACK");
    act(engine, translate(point, variant));
    if (index % 2) while (!engine.gameOver && engine.currentPlayer !== "BLACK") act(engine, null);
  });
  assert.equal(engine.currentPlayer, "BLACK"); assert.equal(engine.gameOver, false);
  return { engine, variant };
}
function sourceReceipt(engine) {
  return { state: saveState(engine), grid: engine.grid, edges: engine.edges, historyHashes: engine.historyHashes,
    cachedTerritories: engine.cachedTerritories, replayFlag: engine._isReplayingBatch,
    evaluateDescriptor: Object.getOwnPropertyDescriptor(engine, "_evaluateMove") };
}
function assertRestored(engine, before, label) {
  assert.deepEqual(saveState(engine), before.state, `${label}: state`);
  assert.equal(engine.grid, before.grid, `${label}: grid reference`);
  assert.equal(engine.edges, before.edges, `${label}: edge reference`);
  assert.equal(engine.historyHashes, before.historyHashes, `${label}: history reference`);
  assert.equal(engine.cachedTerritories, before.cachedTerritories, `${label}: cache reference`);
  assert.equal(engine._isReplayingBatch, before.replayFlag, `${label}: replay flag`);
  assert.deepEqual(Object.getOwnPropertyDescriptor(engine, "_evaluateMove"), before.evaluateDescriptor,
    `${label}: method descriptor`);
}

const independentProbe = (engine, point) => probeMultiplayerReplyResilience(engine, point, {
  maxReplies: engine.validPositions.length + 1, maxProbes: 20000, timeMs: 5000, followupMode: "none",
});

async function realFixtureChecks(runtimeModule, easySpec) {
  let fullRankingCalls = 0;
  const preparedObjects = [[0,0],[1,0],[2,0],[3,0],[4,0]].map((point, index) => ({ point, score: 5-index }));
  const prepared = runtimeModule.prepareStandardDefenseRanking({
    fullRankingContract: { kind: "multiplayer-linear-full-ranking", version: 1 },
    getFullRanking() { fullRankingCalls += 1; return preparedObjects; },
    getTopMoves() { assert.fail("Complete linear ranking must replace the separate top-K enumeration"); },
  }, {}, "BLACK", 4);
  assert.equal(fullRankingCalls, 1); assert.deepEqual(prepared.original, preparedObjects.slice(0,4));
  assert.equal(prepared.completeRanking, preparedObjects);

  const defense = fixtureData.fixtures.find(fixture => fixture.kind === "defense");
  const rows = [];
  for (const rulesVersion of ["territory-v2", "territory-v3"]) for (const count of [3,4,5,6]) {
    const { engine, variant } = buildFixture(defense, count, rulesVersion);
    const safe = translate(defense.candidate, variant), before = sourceReceipt(engine);
    for (const modelId of ["multiplayer-easy-v1", "multiplayer-medium-v1"]) {
      const base = modelId === "multiplayer-easy-v1"
        ? new runtimeModule.FastMultiplayerPolicy(easySpec)
        : (await runtimeModule.createMediumRuntime(engine)).ai;
      const original = base.getTopMoves(engine, engine.currentPlayer, 4);
      assert.ok(original.length >= 2);
      const anchorPoint = original[0].point;
      const runtime = await runtimeModule.loadMultiplayerRuntime(modelId, engine);
      const moves = runtime.ai.getTopMoves(engine, engine.currentPlayer, 1);
      assert.equal(moves.length, 1); assert.ok(Array.isArray(moves[0].point));
      assertRestored(engine, before, `${rulesVersion}/${count}/${modelId}`);
      if (!samePoint(moves[0].point, anchorPoint)) {
        const anchor = independentProbe(engine, anchorPoint), selected = independentProbe(engine, moves[0].point);
        assert.equal(anchor.complete, true); assert.equal(selected.complete, true);
        assert.equal(strictlyImprovesStandardDefense(anchor, selected), true,
          `${rulesVersion}/${count}/${modelId}: changed root must strictly dominate anchor`);
      }
      assert.equal(runtime.ai.lastSearch.standardDefenseGate.status, "selected-strict-defense-improvement",
        `${rulesVersion}/${count}/${modelId}: defense replacement ${JSON.stringify(runtime.ai.lastSearch.standardDefenseGate)}`);
      assert.deepEqual(moves[0].point, safe,
        `${rulesVersion}/${count}/${modelId}: selected equal-capture repair ${JSON.stringify(runtime.ai.lastSearch.standardDefenseGate)}`);
      assert.ok(runtime.ai.lastSearch.standardDefenseGate);
      rows.push({ rulesVersion, count, modelId, anchorPoint, selectedPoint: moves[0].point,
        gate: runtime.ai.lastSearch.standardDefenseGate });
    }
  }

  const chain = fixtureData.fixtures.find(fixture => fixture.kind === "chain");
  for (const modelId of ["multiplayer-easy-v1", "multiplayer-medium-v1"]) {
    const { engine, variant } = buildFixture(chain, 4, "territory-v3"), before = sourceReceipt(engine);
    const chainPoint = translate(chain.candidate, variant);
    const base = modelId === "multiplayer-easy-v1" ? new runtimeModule.FastMultiplayerPolicy(easySpec)
      : (await runtimeModule.createMediumRuntime(engine)).ai;
    const complete = base.getFullRanking(engine, engine.currentPlayer, { includeFeatures: true });
    const chainMove = complete.find(move => samePoint(move.point, chainPoint));
    assert.ok(chainMove); assert.equal(chainMove.features[10], 1);
    assert.ok(chainMove.features[6] < complete[0].features[6],
      "Lower-capture chain witness must fail the equal-immediate-capture candidate filter");
    const guarded = applyStandardDefenseGate(engine, complete.slice(0,4), { completeRanking: complete });
    assert.equal(samePoint(guarded.moves[0].point, chainPoint), false,
      `${modelId}: direct gate must not promote the lower-capture chain witness`);
    assertRestored(engine, before, `chain-gate/${modelId}`);
    const runtime = await runtimeModule.loadMultiplayerRuntime(modelId, engine);
    const move = runtime.ai.getTopMoves(engine, engine.currentPlayer, 1)[0];
    assert.ok(move); assert.equal(samePoint(move.point, chainPoint), false,
      `${modelId}: defense gate must not force the lower-capture chain witness`);
    assert.notEqual(move.evaluation, "canonical-terminal-unique-win",
      "An unconditional unique-win shortcut must not replace the actual policy");
    assert.ok(runtime.ai.lastSearch.passDiscipline);
    assertRestored(engine, before, `chain/${modelId}`);
  }
  return rows;
}

async function threePlayerV4PreservationChecks(runtimeModule) {
  const rows = [];
  for (const rulesVersion of ["territory-v2", "territory-v3"]) for (const gridSize of [5, 7, 9]) {
    const engine = new GameEngine({ gridSize, playerCount: 3, rulesVersion, deferTerritoryUpdates: true });
    const before = sourceReceipt(engine);
    const base = await runtimeModule.createMediumRuntime(engine);
    assert.equal(base.ai.fullRankingContract, undefined,
      `${rulesVersion}/size${gridSize}: v4 shortlist must not claim a complete linear ranking`);
    assert.equal(typeof base.ai.getFullRanking, "undefined",
      `${rulesVersion}/size${gridSize}: v4 shortlist must not expose a full-ranking method`);
    const original = base.ai.getTopMoves(engine, engine.currentPlayer, 3);
    assert.equal(original.length, 3, `${rulesVersion}/size${gridSize}: expected the frozen v4 root width`);
    assertRestored(engine, before, `v4-original/${rulesVersion}/size${gridSize}`);

    const runtime = await runtimeModule.loadMultiplayerRuntime("multiplayer-medium-v1", engine);
    const selected = runtime.ai.getTopMoves(engine, engine.currentPlayer, 3);
    assert.deepEqual(selected, original,
      `${rulesVersion}/size${gridSize}: no complete feature ranking must preserve the exact v4 shortlist`);
    assert.equal(runtime.ai.lastSearch.standardDefenseGate?.status, "preserved-no-repair-candidate",
      `${rulesVersion}/size${gridSize}: v4 preservation must be explicit rather than a silent fallback`);
    assertRestored(engine, before, `v4-runtime/${rulesVersion}/size${gridSize}`);
    rows.push({ rulesVersion, gridSize, points: selected.map(move => move.point),
      gate: runtime.ai.lastSearch.standardDefenseGate.status });
  }
  return rows;
}

async function workerCheck(runtimeModule, easySpec) {
  const defense = fixtureData.fixtures.find(fixture => fixture.kind === "defense");
  const { engine, variant } = buildFixture(defense, 4, "territory-v3"), safe = translate(defense.candidate, variant);
  const anchor = new runtimeModule.FastMultiplayerPolicy(easySpec).getTopMoves(engine, engine.currentPlayer, 1)[0].point;
  const serializedState = serializeEngineState(engine), before = JSON.stringify(serializedState), messages = [];
  const previousSelf = globalThis.self;
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import("../AIWorker.js?standard-defense-gate-test");
    await self.onmessage({ data: { type: "COMPUTE", strategy: "multiplayer",
      modelId: "multiplayer-easy-v1", requestId: "standard-defense-worker", serializedState,
      aiPlayer: serializedState.currentPlayer, topN: 1 } });
    assert.deepEqual(messages.map(message => message.type), ["READY", "RESULT"]);
    const result = messages[1];
    assert.equal(result.requestId, "standard-defense-worker"); assert.equal(result.strategy, "multiplayer");
    assert.equal(result.positionRevision, serializedState.positionRevision);
    assert.equal(result.rulesVersion, serializedState.rulesVersion);
    assert.equal(result.currentPlayer, serializedState.currentPlayer);
    assert.equal(result.modelInfo.id, "multiplayer-easy-v1");
    assert.ok(result.searchStats.standardDefenseGate);
    assert.equal(result.searchStats.standardDefenseGate.status, "selected-strict-defense-improvement");
    assert.deepEqual(result.moves[0].point, safe);
    assert.equal(JSON.stringify(serializedState), before);
  } finally { globalThis.self = previousSelf; }
}

function measureCompleteWindow(runtimeModule, easySpec, count) {
  const defense = fixtureData.fixtures.find(fixture => fixture.kind === "defense");
  const { engine, variant } = buildFixture(defense, count, "territory-v3");
  const policy = new runtimeModule.FastMultiplayerPolicy(easySpec);
  const complete = policy.getFullRanking(engine, engine.currentPlayer, { includeFeatures: true });
  const anchorFeatures = complete[0].features;
  const repairCandidates = complete.map((move, index) => ({ move, index })).filter(({ move, index }) => index > 0
    && move.features?.[10] === 1 && move.features[6] === anchorFeatures[6] && move.features[9] > anchorFeatures[9])
    .sort((left, right) => right.move.features[9] - left.move.features[9]
      || right.move.features[5] - left.move.features[5] || left.index - right.index).map(row => row.move);
  const roots = [complete[0]];
  if (repairCandidates.length) roots.push(repairCandidates[0]);
  const probes = roots.map(move => ({ point: move.point, packet: independentProbe(engine, move.point) }));
  assert.ok(probes.every(row => row.packet.complete));
  return { count, roots: roots.length, safeRootIndex: roots.findIndex(move => samePoint(move.point, translate(defense.candidate, variant))),
    safeRepairIndex: repairCandidates.findIndex(move => samePoint(move.point, translate(defense.candidate, variant))),
    totalProbeMs: probes.reduce((sum, row) => sum + row.packet.elapsedMs, 0),
    perRootMs: probes.map(row => Number(row.packet.elapsedMs.toFixed(3))) };
}

try {
  pureGateChecks();
  const runtimeModule = await import("../MultiplayerRuntime.js?v=20261025-room1");
  const manifest = JSON.parse(await readFile(new URL("../assets/research-ai/multiplayer-v1/manifest.json", import.meta.url), "utf8"));
  const easySpec = manifest.models.find(model => model.id === "multiplayer-easy-v1");
  const rows = await realFixtureChecks(runtimeModule, easySpec);
  const v4Preserved = await threePlayerV4PreservationChecks(runtimeModule);
  await workerCheck(runtimeModule, easySpec);
  const timingDiagnostics = [3,4,6].map(count => measureCompleteWindow(runtimeModule, easySpec, count));
  console.log(JSON.stringify({ status: "PASS_MULTIPLAYER_STANDARD_DEFENSE", cases: rows.length,
    pureFallbacks: true, workerPath: true, v4Preserved, timingDiagnostics, rows }));
} finally {
  globalThis.fetch = originalFetch;
}
