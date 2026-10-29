import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
const noop = () => {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.location = new URL('http://localhost/');
globalThis.document = { body: { classList: { add: noop, remove: noop, toggle: noop } } };
globalThis.addEventListener = noop; globalThis.removeEventListener = noop;
globalThis.Vue = { ref: value => ({ value }), shallowRef: value => ({ value }), computed: read => ({ get value() { return read(); } }), watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: noop };
const sent = [];
globalThis.Worker = class {
  postMessage(message) {
    sent.push(message);
    const state = message.serializedState;
    queueMicrotask(() => this.onmessage?.({ data: {
      type: 'RESULT', requestId: message.requestId, positionRevision: state.positionRevision,
      rulesVersion: state.rulesVersion, currentPlayer: state.currentPlayer, boardHash: state.boardHash,
      moves: [{ type: 'move', vertexId: 'cv:test', point: 'cv:test', score: 1 }],
      searchInfo: { completedDepth: 1, budgetExceeded: true, legalEnumerationComplete: false },
    } }));
  }
  terminate() {}
};
const { default: App, topologyReplayInspectionEffects } = await import('../OnlineApp.js');
const engine = new GameEngine({ boardDefinition: createSurfacePreset('torus', { gridSize: 5 }), playerCount: 2 });
const initial = JSON.stringify(engine.encodeTopologyState());
const app = App.setup();
app.controller.value = { engine };
app.replayMode.value = true;
await app.runAiComparison();
assert.deepEqual(sent.map(x => [x.strategy, x.depth, x.timeLimitMs]), [['topology-generic', 2, 3000], ['topology-generic', 3, 3000]]);
assert.deepEqual(app.aiComparison.value.runs.map(run => run.moves[0].point), ['cv:test', 'cv:test']);
assert.equal(app.aiComparison.value.runs[0].searchInfo.budgetExceeded, true);
assert.equal(JSON.stringify(engine.encodeTopologyState()), initial);
const inspector = App.components.ReplayInspectorPanel;
const props = { language: 'en', uiStyle: 'casual', gameState: { legalMoves: [{ vertexId: 'cv:test' }, [1, 2]], players: [] }, selectedPoint: 'cv:test' };
let selected = null;
const ui = inspector.setup(props, { emit: (_name, value) => { selected = value; } });
assert.deepEqual(ui.candidatePoints.value, ['cv:test', [1, 2]]);
ui.selectCandidate('cv:test');
assert.equal(selected, 'cv:test');
assert.match(ui.selectedCandidateLabel.value, /cv:test/);
props.selectedPoint = null;
assert.equal(ui.selectedCandidateLabel.value, '');
let pendingWorker;
globalThis.Worker = class {
  constructor() { pendingWorker = this; }
  postMessage(message) { this.message = message; this.savedCallback = this.onmessage; }
  terminate() { this.terminated = true; }
};
app.replayDocument.value = { config: {}, actions: [] };
app.controller.value.restoreMatchState = () => ({ success: true, state: { snapshot: engine.getSnapshot() } });
app.replayInspectionPoint.value = 'cv:test';
const pendingComparison = app.runAiComparison();
assert.equal(app.aiComparisonBusy.value, true);
app.handleSeekReplay(0);
assert.equal(pendingWorker.terminated, true, 'seeking cancels in-flight comparison');
assert.equal(app.replayInspectionPoint.value, null);
await pendingComparison;
assert.equal(app.aiComparison.value, null);
assert.equal(app.aiComparisonBusy.value, false);
const staleMessage = pendingWorker.message.serializedState;
pendingWorker.savedCallback?.({ data: { type: 'RESULT', requestId: pendingWorker.message.requestId,
  positionRevision: staleMessage.positionRevision, rulesVersion: staleMessage.rulesVersion,
  currentPlayer: staleMessage.currentPlayer, boardHash: staleMessage.boardHash,
  moves: [{ vertexId: 'cv:test', score: 100 }] } });
assert.equal(app.aiComparison.value, null, 'cancelled response cannot restore old analysis');
console.log('PASS topology replay comparison dispatch, vertex IDs, incomplete metadata and selected-state clearing');

const { createDoubleSphereBoardDefinition } = await import('../RandomSurfaceBoard.js');
const sphereSnapshot = new GameEngine({ boardDefinition: createDoubleSphereBoardDefinition({ gridSize: 5 }), playerCount: 2 }).getSnapshot();
app.gameState.value = { snapshot: sphereSnapshot, lastMoves: {} };
assert.equal(app.hasDoubleTopologyChart.value, true, 'two-piece sphere exposes the view selector');
const groups = new Map();
for (const copy of sphereSnapshot.topology.viewBoard.pointCopies) {
  const sides = groups.get(copy.canonicalVertexId) ?? new Set();
  sides.add(copy.sourceVertexId.startsWith('back:') ? 'back' : 'front');
  groups.set(copy.canonicalVertexId, sides);
}
const backOnly = [...groups].find(([, sides]) => sides.size === 1 && sides.has('back'))?.[0];
const seam = [...groups].find(([, sides]) => sides.size === 2)?.[0];
assert.ok(backOnly && seam);
app.gameState.value.lastMoves = { BLACK: backOnly };
assert.deepEqual(app.topologyChartLatest.value, { front: false, back: true });
app.gameState.value.lastMoves = { BLACK: seam };
assert.deepEqual(app.topologyChartLatest.value, { front: true, back: true });
app.gameState.value = { snapshot: new GameEngine({ boardDefinition: createSurfacePreset('sphere', { gridSize: 5 }), playerCount: 2 }).getSnapshot(), lastMoves: {} };
assert.equal(app.hasDoubleTopologyChart.value, false, 'old one-piece sphere keeps its ordinary UI');
console.log('PASS dual-sphere selector and legacy sphere UI');

// Real topology replay: the first move must count canonical nodes, not empty
// boardMatrix or repeated atlas copies, and its actual score delta is derived
// from isolated pre/post states without rewriting the signed replay.
const { createTopologyReplayDocument } = await import('../ReplayCodec.js');
const cylinderDefinition = createSurfacePreset('cylinder', { gridSize: 5 });
const cylinder = new GameEngine({ boardDefinition: cylinderDefinition, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', deferTerritoryUpdates: false });
const firstMove = cylinder.getLegalMoves().find(move => {
  const candidate = new GameEngine({ boardDefinition: cylinderDefinition, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', deferTerritoryUpdates: false });
  const before = candidate.getSnapshot().territories.BLACK.area;
  return candidate.playMove(move.vertexId).success && candidate.getSnapshot().territories.BLACK.area > before;
});
assert.ok(firstMove, 'fixture requires a move with actual territory growth');
const cylinderReplay = await createTopologyReplayDocument({ boardDefinition: cylinderDefinition, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1' }, [{ type: 'move', vertexId: firstMove.vertexId }]);
const unchangedDocument = JSON.stringify(cylinderReplay);
const effects = topologyReplayInspectionEffects(cylinderReplay, 1);
assert.ok(effects.territoryDelta.BLACK > 0);
assert.equal(JSON.stringify(cylinderReplay), unchangedDocument);
app.replayDocument.value = cylinderReplay;
app.replayCursor.value = 1;
app.replayInspectorOpen.value = false;
assert.ok(app.currentReplayEvent.value.effects?.territoryDelta.BLACK > 0,
  'effects are available even before the details toggle event is delivered');
app.replayInspectorOpen.value = true;
assert.ok(app.currentReplayEvent.value.effects?.territoryDelta.BLACK > 0);
assert.equal(cylinder.playMove(firstMove.vertexId).success, true);
const cylinderSnapshot = cylinder.getSnapshot();
const fixtureProps = { language: 'en', uiStyle: 'casual', gameState: { snapshot: cylinderSnapshot, players: cylinderSnapshot.players, legalMoves: cylinderSnapshot.legalMoves }, event: { ...cylinderReplay.actions[0], effects }, selectedPoint: null };
const fixtureUI = inspector.setup(fixtureProps, { emit: () => {} });
assert.equal(fixtureUI.occupiedCount.value, 3, 'two starting nodes and one move are canonical nodes');
assert.match(fixtureUI.eventSummary.value, /territory delta/);
assert.doesNotMatch(fixtureUI.eventSummary.value, /No clearing or territory change/);
fixtureProps.event = cylinderReplay.actions[0];
assert.match(fixtureUI.eventSummary.value, /Changes for this step are unavailable/);
console.log('PASS cylinder replay canonical node count and actual per-move effects');

// The browser regression starts at cv:4, producing two distinct logical
// paths. Deep proxies mimic the reactive replay document without relying on
// a particular Vue release's internals.
const multiPathReplay = await createTopologyReplayDocument({ boardDefinition: cylinderDefinition, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1' }, [{ type: 'move', vertexId: 'cv:4' }]);
const proxify = (value) => value && typeof value === 'object'
  ? new Proxy(value, { get: (target, key, receiver) => proxify(Reflect.get(target, key, receiver)) })
  : value;
const proxiedEffects = topologyReplayInspectionEffects(proxify(multiPathReplay), 1);
assert.equal(proxiedEffects.addedEdgesByPlayer.BLACK.length, 2);
assert.equal(proxiedEffects.territoryDelta.BLACK, 7);
app.replayDocument.value = proxify(multiPathReplay);
app.replayCursor.value = 1;
app.replayInspectorOpen.value = false;
assert.equal(app.currentReplayEvent.value.effects.territoryDelta.BLACK, 7);
let failOnce = true;
const transientReplay = new Proxy(multiPathReplay, {
  get(target, key, receiver) {
    if (key === 'initialState' && failOnce) { failOnce = false; throw new Error('temporary fixture error'); }
    return Reflect.get(target, key, receiver);
  },
});
app.replayDocument.value = transientReplay;
const savedWarn = console.warn;
try {
  console.warn = () => {};
  assert.equal(app.currentReplayEvent.value.effects, null);
  assert.equal(app.currentReplayEvent.value.effects.territoryDelta.BLACK, 7, 'a temporary failure must not poison the cache');
} finally { console.warn = savedWarn; }
assert.match(App.components.ReplayControls.template, /:aria-label="language === 'zh' \? '复盘控制' : 'Replay controls'"/);
console.log('PASS reactive multipath replay and bilingual control label');
