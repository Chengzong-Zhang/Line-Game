import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import GameController from '../GameController.js';
import { compileBoard } from '../BoardCompiler.js';
import { createTopologyStartingDefinition } from '../TopologyStartingPoints.js';
const values = new Map();
const noop = () => {};
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
globalThis.location = new URL('http://localhost:8876/');
globalThis.document = { body: { classList: { add: noop, remove: noop, toggle: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.Vue = { ref: value => ({ value }), shallowRef: value => ({ value }), computed: fn => ({ get value() { return fn(); } }), watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: noop };
globalThis.Worker = class { postMessage() {} terminate() {} };
const { default: App } = await import('../OnlineApp.js');
const controller = Object.assign(Object.create(GameController.prototype), {
  canvas: { style: {}, setAttribute: noop }, options: { engine: { gridSize: 5, playerCount: 2, rulesVersion: 'territory-v3' } },
  engine: new GameEngine({ gridSize: 5, playerCount: 2 }), _validGridPoints: [], _engineEpoch: 1,
  _authoritativeSnapshotValid: true, multiplayerEnabled: false, localPlayer: null, roomReady: false,
  opponentConnected: false, readOnlyMode: false, lastAction: null, lastMoves: {}, inspectionOverlay: null,
  _networkUnsubscribers: [], _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop,
  _updateLargeBoardClass: noop, _syncCanvasInteractivity: noop, _syncSnapshot: noop,
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop },
});
const setupTemplate = App.components.SetupPanel.template;
const playerSetupAt = setupTemplate.indexOf('<LocalPlayerSetup');
const sizeAt = setupTemplate.indexOf('id="grid-size"');
const shapeAt = setupTemplate.indexOf('id="board-shape"');
const feedbackAt = setupTemplate.indexOf('<slot name="topology-feedback">');
const topologyAt = setupTemplate.indexOf('<slot name="topology">');
assert.ok(playerSetupAt >= 0 && playerSetupAt < sizeAt && sizeAt < shapeAt && shapeAt < feedbackAt && feedbackAt < topologyAt,
  'players precede size, shape, topology error feedback, and the topology editor');
assert.match(App.template, /<template #topology-feedback>[\s\S]*?role="alert"/);
const app = App.setup();
app.controller.value = controller;
app.gameState.value = controller._buildGameState(controller.engine.getSnapshot());
app.tutorialActive.value = false;
app.localMatchStarted.value = true;
app.activeLocalPlayers.value = { BLACK: { choice: 'human' }, WHITE: { choice: 'human' } };
app.selectedPlayerCount.value = 4;
app.handleBoardShapeChange('custom');
app.handleGridSizeChange(5);
assert.ok(app.selectTopologyPreset('sphere'));
const savedEngine = controller.engine;
const savedSnapshot = structuredClone(savedEngine.getSnapshot());
const savedPlayers = structuredClone(app.activeLocalPlayers.value);
const savedDefinition = structuredClone(app.selectedTopologyDefinition.value);
const savedHash = app.selectedTopologyHash.value;
values.set('round3-preserve', 'existing save');
const savedStorage = [...values];
assert.equal(await app.startLocalMatch(), false, '5-point four-player sphere is rejected');
assert.equal(controller.engine, savedEngine);
assert.deepEqual(savedEngine.getSnapshot(), savedSnapshot);
assert.deepEqual(app.activeLocalPlayers.value, savedPlayers);
assert.deepEqual(app.selectedTopologyDefinition.value, savedDefinition);
assert.equal(app.selectedTopologyHash.value, savedHash);
assert.deepEqual([...values], savedStorage);
assert.match(app.actionFeedback.value, /开局无路可走/);
assert.match(app.topologySetupMessage.value, /开局无路可走/);
app.language.value = 'en';
assert.equal(await app.startLocalMatch(), false);
assert.match(app.topologySetupMessage.value, /no legal opening move/);
app.selectedPlayerCount.value = 2;
assert.ok(app.selectTopologyPreset('sphere'));
assert.equal(await app.startLocalMatch(), true, '5-point two-player sphere starts');
assert.equal(controller.engine.activePlayers.length, 2);
assert.ok(controller.engine.activePlayers.every(player => controller.engine.getLegalMoves(player).length));
app.selectedPlayerCount.value = 4;
app.handleGridSizeChange(9);
assert.ok(app.selectTopologyPreset('sphere'));
const compiled = compileBoard(app.selectedTopologyDefinition.value).value;
const roots = Object.fromEntries(Object.entries(compiled.startingRoots).map(([player, ids]) => [player, [...ids]]));
let custom = null;
for (const spare of compiled.sampleIds) {
  if (Object.values(roots).flat().includes(spare)) continue;
  try {
    const proposed = createTopologyStartingDefinition(compiled, { playerCount: 4, mode: 'custom', roots: { ...roots, BLACK: [spare] } });
    const candidate = new GameEngine({ boardDefinition: proposed, playerCount: 4, rulesVersion: 'surface-v1' });
    if (candidate.activePlayers.every(player => candidate.getLegalMoves(player).length)) { custom = candidate.initialRoots; break; }
  } catch (_) {}
}
assert.ok(custom, 'find a playable changed custom root');
app.updateTopologyStarts({ mode: 'custom', roots: custom });
const selectedRoots = compileBoard(app.selectedTopologyDefinition.value).value.startingRoots;
assert.deepEqual(selectedRoots, custom);
assert.equal(await app.startLocalMatch(), true, '9-point four-player sphere starts');
assert.deepEqual(controller.engine.initialRoots, selectedRoots, 'the chosen roots are never moved by admission');
assert.ok(controller.engine.activePlayers.every(player => controller.engine.getLegalMoves(player).length));
console.log('PASS isolated topology opening admission, atomic rejection, bilingual feedback, playable 5/2 and 9/4, exact custom roots');
