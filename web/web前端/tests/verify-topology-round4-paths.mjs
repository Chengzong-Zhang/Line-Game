import assert from 'node:assert/strict';
import { createSurfacePreset } from '../BoardPresets.js';
import { compileBoardOrThrow } from '../BoardCompiler.js';
import { enumerateConnections, physicalPathKey, transportDirectionAcrossSeam } from '../BoardPaths.js';
import { expandPathEdgeOccurrences } from '../BoardPathProjection.js';
import { projectPath } from '../BoardView.js';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';

const cylinder = createSurfacePreset('cylinder', { width: 5, height: 5 });
cylinder.startingVertices = { BLACK: 'v:1,0', WHITE: 'v:2,4' };
const board = compileBoardOrThrow(cylinder);
const start = board.rawVertexToCanonical['v:0,0'];
const target = board.rawVertexToCanonical['v:1,0'];
assert.equal(start, board.rawVertexToCanonical['v:5,0'], 'seam copies denote one node');
const pos = { coverageByPlayer: { BLACK: [target] } };
const oldCylinder = structuredClone(cylinder);
oldCylinder.topology.movementStrategy = 'simple-rays-v2';
const oldBoard = compileBoardOrThrow(oldCylinder);
const historical = enumerateConnections(oldBoard, pos, start, 'BLACK', { geometryOnly: true });
const current = enumerateConnections(board, pos, start, 'BLACK');
const shortOld = historical.filter(p => p.vertices.length === 2);
assert.ok(shortOld.length >= 2, 'fixture contains old zero-distance seam aliases');
assert.equal(new Set(shortOld.map(p => physicalPathKey(board, p))).size, 1);
assert.equal(current.filter(p => p.vertices.length === 2).length, 1);
assert.ok(current.some(p => p.vertices.length > 2 && p.endVertexId === target),
  'different-endpoint route around the cylinder remains distinct');
assert.ok(current.every(p => p.startVertexId !== p.endVertexId && new Set(p.vertices).size === p.vertices.length));
assert.deepEqual(enumerateConnections(board, { coverageByPlayer: { BLACK: [] } }, start, 'BLACK'), [],
  'a new node alone does not form a self connection');

// A pre-fix saved v2 state may contain both physical aliases. Restore must
// validate their original IDs and geometry instead of silently rewriting them.
const game = new GameEngine({ boardDefinition: oldCylinder });
game._setState(start, game._getPlayerStates('BLACK').node);
for (const path of shortOld) game.topologyPaths.BLACK.set(path.pathId, path);
game._rebuildTopology();
const saved = game.encodeTopologyState();
const restored = new GameEngine({ boardDefinition: oldCylinder });
assert.equal(restored.restoreTopologyState(saved), true);
assert.deepEqual(restored.getTopologyRuleState(), game.getTopologyRuleState());

const screenshotOld = createSurfacePreset('cylinder', { width: 8, height: 8 });
screenshotOld.topology.movementStrategy = 'simple-rays-v2';
const screenshotNew = structuredClone(screenshotOld);
screenshotNew.topology.movementStrategy = 'simple-rays-v3';
const oldScreenshotBoard = compileBoardOrThrow(screenshotOld), newScreenshotBoard = compileBoardOrThrow(screenshotNew);
const at = (b, x, y) => b.rawVertexToCanonical[`v:${x},${y}`];
const routes = b => enumerateConnections(b, {coverageByPlayer: {BLACK: [at(b,3,2)]}}, at(b,1,5), 'BLACK');
assert.ok(routes(oldScreenshotBoard).some(p => p.vertices.includes(at(oldScreenshotBoard,7,5))
  && p.seamCrossings.some(c => c.sourceDirectionState === 0 && c.targetDirectionState === 5)),
  'old version reproduces the screenshot-like 60 degree turn');
assert.equal(routes(newScreenshotBoard).length, 0, 'corrected cylinder ray cannot turn into the old endpoint');
const across = enumerateConnections(newScreenshotBoard, {coverageByPlayer:{BLACK:[at(newScreenshotBoard,7,5)]}},
  at(newScreenshotBoard,1,5), 'BLACK');
assert.ok(across.some(p => p.seamCrossings.some(c => c.sourceDirectionState === 3 && c.targetDirectionState === 3)),
  'a straight line to a different endpoint still crosses the cylinder seam');
for (const definition of [screenshotOld, screenshotNew]) definition.startingVertices = {BLACK:'v:3,2', WHITE:'v:4,8'};
const oldMoveGame = new GameEngine({boardDefinition:screenshotOld});
const newMoveGame = new GameEngine({boardDefinition:screenshotNew});
assert.equal(oldMoveGame.playMove([1,5]).success, true, 'old action remains replayable');
assert.equal(newMoveGame.playMove([1,5]).success, false, 'new move cannot connect only by bending');
const oldMoveState = oldMoveGame.encodeTopologyState();
const oldMoveRestored = new GameEngine({boardDefinition:screenshotOld});
assert.equal(oldMoveRestored.restoreTopologyState(oldMoveState), true);
assert.deepEqual(oldMoveRestored.getTopologyRuleState(), oldMoveGame.getTopologyRuleState());

// Real v3 gameplay: two different routes connect cv:4 to the root. The first
// cut removes only one route; the second cuts the remaining route and removes
// the now-disconnected node, while an independent root-connected node remains.
const cutGame = new GameEngine({boardDefinition:createSurfacePreset('cylinder',{gridSize:5})});
assert.equal(cutGame.playMove('cv:4').success,true);
assert.equal(cutGame.topologyPaths.BLACK.size,2);
assert.equal(cutGame.getLegalMoves().find(m=>m.vertexId==='cv:3')?.isAttack,true);
assert.equal(cutGame.playMove('cv:3').success,true);
assert.ok(cutGame._getPlayerNodes('BLACK').includes('cv:4'));
assert.equal(cutGame.topologyPaths.BLACK.size,1);
assert.equal(cutGame.playMove('cv:10').success,true);
assert.equal(cutGame.getLegalMoves().find(m=>m.vertexId==='cv:8')?.isAttack,true);
assert.equal(cutGame.playMove('cv:8').success,true);
assert.deepEqual(cutGame._getPlayerNodes('BLACK').sort(),['cv:0','cv:10']);
assert.equal(cutGame.grid.get('cv:4'),0);

// Across every paired seam the unfolding map is an invertible isometry of the
// six directions, including orientation-reversing gluings.
for (const name of ['cylinder','torus','mobius','klein-bottle','tetrahedron','sphere','cone']) {
  const compiled = compileBoardOrThrow(createSurfacePreset(name, {gridSize:9}));
  for (const transition of compiled.directionTransitions) {
    const inverse = compiled.directionTransitions.find(x => x.fromEdgeOccurrenceId === transition.toEdgeOccurrenceId
      && x.toEdgeOccurrenceId === transition.fromEdgeOccurrenceId);
    assert.ok(inverse, `${name} seam has reverse transition`);
    const mapped = Array.from({length:6}, (_,d) => transportDirectionAcrossSeam(compiled,transition,d));
    assert.equal(new Set(mapped).size,6);
    for (let d=0;d<6;d++) assert.equal(transportDirectionAcrossSeam(compiled,inverse,mapped[d]),d,
      `${name} direction transport must invert`);
  }
}

// Every explicitly paired tetrahedron/sphere seam edge must be rendered at
// both actual local occurrences, including pairs 5–12. No canonical-endpoint
// join or long atlas chord is permitted.
for (const preset of ['tetrahedron', 'sphere']) {
  const g = new GameEngine({ boardDefinition: createSurfacePreset(preset, { gridSize: 9 }) });
  const view = g.getSnapshot().topology.viewBoard;
  const edges = new Map(view.displayEdges.map(e => [e.id.slice('guide:'.length), e]));
  const copies = new Map(view.pointCopies.map(c => [c.id, c]));
  for (const pair of view.seamPairs) for (const [a,b] of [[pair.edgeOccurrenceA,pair.edgeOccurrenceB],[pair.edgeOccurrenceB,pair.edgeOccurrenceA]]) {
    assert.deepEqual(new Set(expandPathEdgeOccurrences(view, [a])), new Set([a,b]));
    const edge = edges.get(a);
    const vertices = edge.copyIds.map(id => copies.get(id).canonicalVertexId);
    const segments = projectPath(view, { vertices, edgeOccurrences: [a], pathId: 'fixture' });
    assert.equal(segments.length, 2);
    assert.deepEqual(new Set(segments.map(s => s.copyIds.join('|'))),
      new Set([a,b].map(id => edges.get(id).copyIds.join('|'))));
    for (const segment of segments) assert.ok(Math.hypot(
      segment.points[0][0] - segment.points[1][0], segment.points[0][1] - segment.points[1][1]) < 1.001,
    'only unit atlas edges are drawn');
  }
}
console.log('PASS: seam alias dedup, distinct cylinder routes, pre-fix state restore, tetrahedron/sphere paired edge projections');
