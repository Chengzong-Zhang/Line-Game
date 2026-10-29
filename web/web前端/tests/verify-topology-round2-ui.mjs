import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileBoard } from '../BoardCompiler.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { createTopologyStartingDefinition } from '../TopologyStartingPoints.js';
import Setup, { topologyStartCopies } from '../TopologyStartingPointSetup.js';

globalThis.Vue = {
  ref: (value) => ({ value }),
  computed: (fn) => ({ get value() { return fn(); } }),
  watch: () => {},
};
for (const size of [5, 9, 15]) {
  const result = compileBoard(createSurfacePreset('cylinder', { gridSize: size }));
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.equal(Math.max(...result.value.definition.vertices.map(v => v.coordinate[0])), size - 1);
}
const board = compileBoard(createSurfacePreset('cylinder', { gridSize: 5 })).value;
const definition = createTopologyStartingDefinition(board, { playerCount: 2, mode: 'random', countPerPlayer: 2, random: () => 0.5 });
const compiled = compileBoard(definition).value;
assert.equal(compiled.startingRoots.BLACK.length, 2);
assert.equal(compiled.startingRoots.WHITE.length, 2);
assert.notEqual(board.boardHash, compiled.boardHash);
const copies = topologyStartCopies(compiled, 2);
for (const root of compiled.startingRoots.BLACK) {
  assert.ok(copies.filter(p => p.canonicalVertexId === root).every(p => p.owner === 0));
}
const seam = compiled.canonicalVertices.find(v => v.sourceVertexIds.length > 1);
assert.ok(seam, 'cylinder has a duplicated canonical seam point');
const assigned = createTopologyStartingDefinition(compiled, { playerCount: 2, mode: 'custom', roots: {
  BLACK: [seam.id], WHITE: [compiled.sampleIds.find(id => id !== seam.id)],
} });
const props = { definition: assigned, playerCount: 2, language: 'en', locked: false };
let change;
const component = Setup.setup(props, { emit: (event, value) => { if (event === 'change') change = value; } });
const mapped = component.copies.value.filter(p => p.canonicalVertexId === seam.id);
assert.ok(mapped.length > 1 && mapped.every(p => p.owner === 0));
component.active.value = 'BLACK';
const spare = compileBoard(assigned).value.sampleIds.find(id => !component.copies.value.some(p => p.canonicalVertexId === id && p.owner !== undefined));
component.toggle(spare);
assert.ok(change.roots.BLACK.includes(seam.id) && change.roots.BLACK.includes(spare));
const prior = change;
component.toggle(compileBoard(assigned).value.startingVertices.WHITE);
assert.equal(change, prior, 'cannot allocate another player’s canonical point');
const app = await readFile(new URL('../OnlineApp.js', import.meta.url), 'utf8');
assert.match(app, /\['triangle', 'hexagon', 'custom'\]/);
assert.match(app, /TopologySetupPanel v-if="selectedBoardShape === 'custom'"/);
assert.match(app, /topologyDraftsBySize\.set/);
// Candidate failure is checked through the actual app handler in verify-topology-round3-ui.mjs.
assert.match(app, /SettlementBoardPreview v-else-if/);
assert.match(app, /开始拓扑新手引导/);
console.log('verify-topology-round2-ui: PASS (size, multi-root and seam copies, seat isolation, setup/settlement wiring)');

const { topologyStartGeometry, topologyDefaultDefinition } = await import('../TopologyStartingPointSetup.js');
const { generateBoard } = await import('../RandomBoard.js');
for (let size = 5; size <= 15; size++) {
  for (const name of ['cylinder', 'mobius', 'torus', 'klein-bottle', 'tetrahedron']) {
    const result = compileBoard(createSurfacePreset(name, { gridSize: size }));
    assert.ok(result.ok, `${name}/${size}: ${JSON.stringify(result.errors)}`);
    const extent = Math.max(...result.value.definition.vertices.map(v => Math.max(...v.coordinate)));
    assert.equal(extent, name === 'tetrahedron' && size % 2 === 0 ? size - 2 : size - 1, `${name}/${size} extent`);
  }
  const random = generateBoard({ gridSize: size, playerCount: 6, roughness: .45, minimumChannelWidth: 2, minStartDistance: 2, maxAttempts: 24 }, `ui-size-${size}`, 'random-board-v1');
  assert.ok(random.ok, `random/${size}: ${JSON.stringify(random.errors)}`);
  assert.ok(random.definition.vertices.every(v => v.coordinate.every(c => c >= 0 && c < size)));
}
const tetra = compileBoard(createSurfacePreset('tetrahedron', { gridSize: 5 })).value;
const tetraCopies = topologyStartGeometry(tetra, 2);
const repeated = tetra.canonicalVertices.find(v => v.sourceVertexIds.length > 1);
const other = tetra.sampleIds.find(id => id !== repeated.id);
const tetraAssigned = compileBoard(createTopologyStartingDefinition(tetra, { playerCount: 2, mode: 'custom', roots: { BLACK: [repeated.id], WHITE: [other] } })).value;
const projected = topologyStartGeometry(tetraAssigned, 2);
assert.ok(projected.copies.filter(p => p.canonicalVertexId === repeated.id).length > 1);
assert.ok(projected.copies.filter(p => p.canonicalVertexId === repeated.id).every(p => p.owner === 0));
assert.ok(projected.edges.some(e => e.seam !== undefined), 'seam occurrences have visible geometry');
const byCoordinate = new Map(tetraCopies.copies.map(p => [p.coordinate.join(','), p]));
const origin = byCoordinate.get('0,0'), right = byCoordinate.get('1,0'), down = byCoordinate.get('0,1');
assert.ok(origin && right && down);
assert.ok(Math.abs((down.x - origin.x) / (right.x - origin.x) - 0.5) < 1e-9);
assert.ok(Math.abs((down.y - origin.y) / (right.x - origin.x) - Math.sqrt(3) / 2) < 1e-9);
const restored = compileBoard(topologyDefaultDefinition(tetraAssigned.definition, 5)).value;
assert.deepEqual(restored.startingRoots, tetra.startingRoots, 'saved preset custom starts restore the preset defaults');
console.log('verify-topology-round2-size-and-projection: PASS (all sizes, presets and random, tetra copies and preset defaults)');
const playerSetupSource = await readFile(new URL('../LocalPlayerSetup.js', import.meta.url), 'utf8');
const { getGuideMarkdown } = await import('../GuideContent.js');
const guideSource = getGuideMarkdown('rulesMath', 'zh');
assert.match(playerSetupSource, /AI 榜与适用范围/);
assert.match(playerSetupSource, /练习模式 · 棋力未评测/);
assert.match(app, /@open-topology-guide="handleOpenGuideEntry\('topology'\)"/);
assert.match(guideSource, /拓扑人机保持练习属性/);
console.log('verify-topology-round2-ladder-scope: PASS (practice label, guide entry and no remote ranking claim)');
