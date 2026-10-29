import assert from 'node:assert/strict';
import { notchScreenshotFixture, tetrahedronScreenshotFixture } from './fixtures/topology-round3-visual-fixtures.mjs';
import { buildTopologyTerritoryDisplay, pointInDisplayPolygon } from '../TerritoryDisplay.js';
import { projectPath } from '../BoardView.js';
import { buildSurfaceCells } from '../TopologySurface3D.js';

const notch=notchScreenshotFixture(), before=structuredClone(notch.territories);
const contours=buildTopologyTerritoryDisplay(notch);
assert.ok(contours.some(p=>p.player==='BLACK'&&pointInDisplayPolygon([4,5],p.polygon)),'the screenshot blue lower interior is colored');
assert.ok(!contours.some(p=>p.player==='BLACK'&&pointInDisplayPolygon([4,6.8],p.polygon)),'the blue display excludes the absent bottom notch');
assert.ok(!notch.topology.viewBoard.pointCopies.some(c=>c.coordinate[0]===4&&c.coordinate[1]===7),'the notch really lies outside playable points');
assert.ok(contours.some(p=>p.player==='WHITE'&&pointInDisplayPolygon([2,1],p.polygon)),'the red upper region stays red');
assert.deepEqual(notch.territories,before,'display does not change official territory');
const tetra=tetrahedronScreenshotFixture(), surface=buildSurfaceCells(tetra,2);
assert.ok(buildTopologyTerritoryDisplay(tetra).some(p=>p.player==='WHITE'&&pointInDisplayPolygon([1.8,3.4],p.polygon)),'legacy crossing screenshot has continuous interior color');
assert.ok(!buildTopologyTerritoryDisplay(tetra).some(p=>p.player==='BLACK'),'the blue straight edge does not grow area');
assert.ok(surface.cells.some(cell=>cell.player==='WHITE'),'the same region is visible in 3D');
for(const paths of Object.values(tetra.topologyPaths))for(const path of paths){
  const segments=projectPath(tetra.topology.viewBoard,path);
  assert.equal(segments.length,path.edgeOccurrences.length);
  assert.ok(segments.every(s=>Math.hypot(s.points[0][0]-s.points[1][0],s.points[0][1]-s.points[1][1])<1.001),'a screenshot path is drawn by actual unit occurrences');
}
console.log('PASS: screenshot-shaped notch and legacy tetrahedron visual fixtures; these are not recovered original move histories');
