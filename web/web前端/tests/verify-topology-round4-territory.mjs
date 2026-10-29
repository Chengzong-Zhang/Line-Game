import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { buildTopologyTerritoryDisplay, pointInDisplayPolygon } from '../TerritoryDisplay.js';
import { buildSurfaceCells, resolveSurfaceSamplePlayer } from '../TopologySurface3D.js';
import { notchScreenshotFixture } from './fixtures/topology-round3-visual-fixtures.mjs';
import { sphereSeamTriangleFixture } from './fixtures/topology-round4-territory-fixtures.mjs';

const covered = (pieces, player, point) => pieces.some(piece => piece.player === player && pointInDisplayPolygon(point, piece.polygon));
const twiceArea = polygon => polygon.reduce((sum, p, i) => sum + p[0]*polygon[(i+1)%polygon.length][1]-p[1]*polygon[(i+1)%polygon.length][0], 0);

// Screenshot-shaped reconstruction, not the original history: the retained
// native contour covers an actual face while the missing notch is excluded.
const notch = notchScreenshotFixture(), notchScore = structuredClone(notch.territories);
const notchPieces = buildTopologyTerritoryDisplay(notch);
assert.ok(covered(notchPieces, 'BLACK', [4,5]));
assert.ok(!covered(notchPieces, 'BLACK', [4,6.8]));
assert.deepEqual(notch.territories, notchScore);

// On the same candidate polygon remove a real interior face. Sample its
// centroid away from boundaries; all other genuine faces stay eligible.
const hole = structuredClone(notch);
const view = hole.topology.viewBoard, copies = new Map(view.pointCopies.map(c => [c.id,c]));
const target = view.faces.find(f => {
  const pts = f.copyIds.map(id => copies.get(id).coordinate);
  const center = [0,1].map(axis => pts.reduce((sum,p)=>sum+p[axis],0)/3);
  return covered(notchPieces, 'BLACK', center);
});
assert.ok(target);
const centroid = [0,1].map(axis => target.copyIds.reduce((sum,id)=>sum+copies.get(id).coordinate[axis],0)/3);
view.faces = view.faces.filter(face => face.id !== target.id);
const holePieces = buildTopologyTerritoryDisplay(hole);
assert.ok(!covered(holePieces, 'BLACK', centroid), 'removed internal face is a hole');
assert.ok(holePieces.some(p => p.player === 'BLACK'), 'remaining board area retains the contour');

// On this explicit seam net the three physical walls form the triangle
// x >= 0, y >= 0, x+y <= 4. The two other apparent sides are seam mates of
// the played boundary edges. Check all 64 face centroids, including the
// nine outside faces that were mistakenly painted by the local hull.
for (const kind of ['sphere','tetrahedron']) {
  const snap=sphereSeamTriangleFixture(kind), view=snap.topology.viewBoard;
  const byId=new Map(view.pointCopies.map(copy=>[copy.id,copy]));
  const before=structuredClone(snap.territories), pieces=buildTopologyTerritoryDisplay(snap);
  let inside=0, outside=0;
  for (const face of view.faces) {
    const center=[0,1].map(axis=>face.copyIds.reduce((sum,id)=>sum+byId.get(id).coordinate[axis],0)/3);
    const expected=center[0]+center[1]<4;
    const actual=pieces.some(piece=>piece.player==='BLACK' && piece.faceId===face.id && pointInDisplayPolygon(center,piece.polygon));
    assert.equal(actual,expected,`${kind}: explicit seam triangle face ${face.id}`);
    if(expected) inside++; else outside++;
  }
  assert.equal(inside,16); assert.equal(outside,48);
  const surface=buildSurfaceCells(snap,3);
  for(const cell of surface.cells) {
    const expected=resolveSurfaceSamplePlayer(pieces.filter(p=>p.faceId===cell.faceId && pointInDisplayPolygon(cell.atlasCenter,p.polygon)));
    assert.equal(cell.player,expected,`${kind}: seam fixture 2D/3D ${cell.faceId}`);
  }
  assert.deepEqual(snap.territories,before);
}

// Actual legal actions on both equivalent atlas meshes; these are not a
// claimed replay of the screenshot. Face witnesses exercise a seam and an
// ordinary interior, with explicit outside faces rather than a face-count cap.
for (const kind of ['sphere','tetrahedron']) {
  const game = new GameEngine({boardDefinition:createSurfacePreset(kind,{gridSize:7})});
  for (const id of ['cv:3','cv:15','cv:1','cv:17','cv:6','cv:8','cv:19']) {
    assert.equal(game.playMove(id).success, true, `${kind}: legal action ${id}`);
  }
  const before = structuredClone(game.getScoreboard()), snap = game.getSnapshot();
  const pieces = buildTopologyTerritoryDisplay(snap);
  const blackFaces = new Set(pieces.filter(p=>p.player==='BLACK').map(p=>p.faceId));
  for (const id of ['d:0,0','d:0,1','u:0,0','u:0,1','u:0,2']) assert.ok(blackFaces.has(id), `${kind}: expected ${id}`);
  for (const id of ['u:3,0','u:2,2','d:3,1']) assert.ok(!blackFaces.has(id), `${kind}: outside ${id}`);
  assert.ok(pieces.every(p => p.faceId && twiceArea(p.polygon)>1e-9), 'nonzero pieces share Canvas winding');
  const surface = buildSurfaceCells(snap,3);
  for (const cell of surface.cells) {
    const matches = pieces.filter(p=>p.faceId===cell.faceId && pointInDisplayPolygon(cell.atlasCenter,p.polygon));
    assert.equal(cell.player, resolveSurfaceSamplePlayer(matches), `${kind}: 2D/3D owner at ${cell.faceId}`);
  }
  assert.deepEqual(game.getScoreboard(), before, `${kind}: score unchanged`);
}
console.log('PASS: clipped notch and hole, actual sphere/tetrahedron actions, face witnesses, winding, and 2D/3D ownership');
