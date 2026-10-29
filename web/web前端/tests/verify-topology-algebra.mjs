import assert from 'node:assert/strict';
import { createSurfacePreset, createKleinBottleBoardDefinition, createCylinderBoardDefinition } from '../BoardPresets.js';
import { compileBoardOrThrow } from '../BoardCompiler.js';
import { analyzeBoardAlgebra, analyzeEdgeCycle } from '../TopologyAlgebra.js';

const cases = [
  ['cone', [1, 0, 0], true, 1, 0], ['sphere', [1, 0, 1], true, 0, 0],
  ['cylinder', [1, 1, 0], true, 2, 0], ['mobius', [1, 1, 0], false, 1, null],
  ['torus', [1, 2, 1], true, 0, 1], ['klein', [1, 2, 1], false, 0, null],
];
for (const n of [5, 9, 15]) for (const [name, betti, orientable, boundaries, genus] of cases) {
  const definition = name === 'klein' ? createKleinBottleBoardDefinition({ gridSize: n })
    : createSurfacePreset(name, { gridSize: n });
  const board = compileBoardOrThrow(definition), result = analyzeBoardAlgebra(board);
  assert.deepEqual(result.betti, betti, `${name} n=${n}`);
  assert.equal(result.chainCondition, true);
  assert.equal(result.eulerIdentityVerified, true);
  assert.equal(result.surface.degreeIdentityVerified, true);
  assert.equal(result.surface.manifold, true);
  assert.equal(result.surface.orientable, orientable);
  assert.equal(result.surface.boundaryCount, boundaries);
  assert.equal(result.surface.genus, genus);
  // One face boundary bounds that 2-cell, including on a nonorientable surface.
  const ids = board.edgeOccurrences.filter(o => o.faceId === definition.faces[0].id).map(o => o.edgeClassId);
  const cycle = analyzeEdgeCycle(board, ids);
  assert.equal(cycle.cycle, true);
  assert.equal(cycle.nullHomologous, true);
  assert.equal(cycle.separating, boundaries === 0 ? true : null);
  assert.equal(analyzeEdgeCycle(board, [ids[0]]).cycle, false);
  assert.equal(analyzeEdgeCycle(board, [ids[0], ids[0]]).nullHomologous, true);
  assert.equal(analyzeEdgeCycle(board, [ids[0], ids[0]]).separating, null);
  assert.deepEqual(analyzeBoardAlgebra(board), result, 'immutable cached data is observationally stable');
}

const torus = compileBoardOrThrow(createSurfacePreset('torus', { gridSize: 7 }));
const meridian = Array.from({ length: 6 }, (_, x) => torus.edgeOccurrences.find(o =>
  o.vertices.includes(`v:${x},0`) && o.vertices.includes(`v:${x + 1},0`)).edgeClassId);
assert.deepEqual(analyzeEdgeCycle(torus, meridian), {
  version: 'topology-algebra-f2-v1', field: 'F2', relativeBoundary: false,
  cycle: true, nullHomologous: false, embeddedCircle: true, separating: false, boundaryVertexIds: [],
}, 'a torus winding circle does not separate');

const cylinder = compileBoardOrThrow(createCylinderBoardDefinition({ gridSize: 7 }));
const radial = Array.from({ length: 6 }, (_, y) => cylinder.edgeOccurrences.find(o =>
  o.vertices.includes(`v:1,${y}`) && o.vertices.includes(`v:1,${y + 1}`)).edgeClassId);
assert.equal(analyzeEdgeCycle(cylinder, radial).cycle, false);
assert.equal(analyzeEdgeCycle(cylinder, radial, { relativeBoundary: true }).cycle, true);
assert.equal(analyzeEdgeCycle(cylinder, radial, { relativeBoundary: true }).nullHomologous, false);
assert.equal(analyzeEdgeCycle(cylinder, radial, { relativeBoundary: true }).separating, null);
assert.deepEqual(analyzeBoardAlgebra(cylinder, { relativeBoundary: true }).betti, [0, 1, 1]);

// A finite cell complex can have parallel 1-cells; simple graph adjacency
// would collapse this circle and give the wrong H_1. No manifold is claimed.
const parallel = {
  canonicalVertices: [{ id: 'a' }, { id: 'b' }],
  edgeClasses: [
    { id: 'x', canonicalVertices: ['a', 'b'], occurrences: [] },
    { id: 'y', canonicalVertices: ['a', 'b'], occurrences: [] },
  ], definition: { faces: [] }, realBoundarySampleIds: [], realBoundaryEdgeClassIds: [],
  boundaryComponents: [], vertexLinks: [], orientable: true,
};
assert.deepEqual(analyzeBoardAlgebra(parallel).betti, [1, 1, 0]);
assert.equal(analyzeBoardAlgebra(parallel).surface.manifold, false);
assert.equal(analyzeEdgeCycle(parallel, ['x', 'y']).nullHomologous, false);
assert.equal(analyzeEdgeCycle(parallel, ['x', 'y']).separating, null);
assert.throws(() => analyzeEdgeCycle(torus, ['unknown-edge']), /unknown edge/);
console.log('PASS: F2 chain condition, absolute/relative homology, surface classification, nonseparating cycles and parallel edges.');
