import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { buildTopologyTerritoryDisplay, pointInDisplayPolygon } from '../TerritoryDisplay.js';
import { projectPath } from '../BoardView.js';

function make(seamed) {
  const def = createSurfacePreset('cylinder', {width: 7, height: 7});
  if (!seamed) def.seamPairs = [];
  const snap = new GameEngine({boardDefinition:def}).getSnapshot();
  for (const key of Object.keys(snap.boardStates)) snap.boardStates[key] = 0;
  snap.territories = {BLACK:{area:17, renderPoints:[], components:[]}};
  return snap;
}
const chain = [[1,3],[1,2],[1,1],[2,1],[3,1],[3,2],[3,3]];
function install(snap, coordinates) {
  const view = snap.topology.viewBoard;
  const copies = coordinates.map(([x,y]) => view.pointCopies.find(c=>c.coordinate[0] === x && c.coordinate[1] === y));
  for (const [i,c] of copies.entries()) snap.boardStates[c.canonicalVertexId] = i === 0 || i === 2 || i === copies.length-1 ? 1 : 2;
  const paths = [];
  for (let i=0;i<copies.length-1;i++) {
    const a=copies[i], b=copies[i+1];
    const edge=view.displayEdges.find(e=> e.copyIds.includes(a.id) && e.copyIds.includes(b.id));
    assert.ok(edge, `missing edge ${i}`);
    paths.push(edge.id.replace(/^guide:/,''));
  }
  snap.topologyPaths = {BLACK:[{vertices:copies.map(c=>c.canonicalVertexId),edgeOccurrences:paths}]};
  return copies;
}
const planar=make(false); const planarCopies=install(planar,chain);
const before=structuredClone(planar.territories);
const middle=planar.topology.viewBoard.pointCopies.find(c=>c.coordinate[0]===2 && c.coordinate[1]===2);
planar.topology.viewBoard.faces=planar.topology.viewBoard.faces.filter(f=>!f.copyIds.includes(middle.id));
const p=buildTopologyTerritoryDisplay(planar).filter(x=>x.player==='BLACK');
assert.ok(!p.some(x=>pointInDisplayPolygon([2.1,2.1],x.polygon)), 'open contour excludes the absent patch');
assert.deepEqual(planar.territories,before,'display cannot alter score');
const seam=make(true); install(seam,chain);
const shapes=buildTopologyTerritoryDisplay(seam).filter(x=>x.player==='BLACK');
assert.ok(shapes.some(s=>pointInDisplayPolygon([2.1,2.1],s.polygon)), 'local open chain fills area on a seamed board');
assert.ok(shapes.every(s=>s.kind==='face' && s.polygon.every(q=>q[0]>=0 && q[0]<=7 && q[1]>=0 && q[1]<=7)), 'surface display stays on real local faces');
assert.equal(seam.territories.BLACK.area,17);
const segments=projectPath(seam.topology.viewBoard,seam.topologyPaths.BLACK[0]);
assert.equal(segments.length,chain.length-1);
assert.ok(segments.every(s=> Math.hypot(s.points[1][0]-s.points[0][0],s.points[1][1]-s.points[0][1]) < 1.01), 'only physical unit edges, no across-atlas chord');
const line=make(true); install(line,[[1,2],[2,2],[3,2]]);
assert.equal(buildTopologyTerritoryDisplay(line).length,0,'single line has no area');
// Two atlas copies of the same long seam line must never combine into a
// spurious strip. Conversely, a seam-side wedge has genuine area even though
// no interior lattice vertex exists.
const duplicate=make(true);
install(duplicate,[[0,1],[0,2],[0,3],[0,4]]);
const leftPath=duplicate.topologyPaths.BLACK[0];
install(duplicate,[[7,1],[7,2],[7,3],[7,4]]);
duplicate.topologyPaths.BLACK.unshift(leftPath);
assert.equal(buildTopologyTerritoryDisplay(duplicate).length,0,'parallel copies of one seam line are not a filled band');
const tiny=make(true);
install(tiny,[[1,1],[0,2],[0,1]]);
const leftWedge=tiny.topologyPaths.BLACK[0];
install(tiny,[[6,2],[7,1],[7,2]]);
tiny.topologyPaths.BLACK.unshift(leftWedge);
const tinyParts=buildTopologyTerritoryDisplay(tiny);
assert.ok(tinyParts.some(s=>pointInDisplayPolygon([0.2,1.4],s.polygon)), 'seam-side wedge without interior lattice vertices is painted');
assert.ok(tinyParts.every(s=>s.kind==='face'), 'both seam-side pieces stay on local faces');
// Assemble a genuine closed wall along the boundary of selected physical
// faces, identifying paired seam occurrences. Interior seam edges are not
// played: the test therefore requires dual adjacency across the seam.
function installFaceWalls(snap, selectedIds) {
  const view=snap.topology.viewBoard, chosen=new Set(selectedIds), groups=new Map(), occurrences=new Map();
  for (const face of view.faces) for(let i=0;i<3;i++) {
    const a=face.copyIds[i],b=face.copyIds[(i+1)%3],key=[a,b].sort().join('|'),id=`${face.id}:${i}`;
    const item={id,face,a,b}; occurrences.set(id,item);
    if(!groups.has(key))groups.set(key,[]); groups.get(key).push(item);
  }
  const seam=new Map();for(const p of view.seamPairs){seam.set(p.edgeOccurrenceA,p.edgeOccurrenceB);seam.set(p.edgeOccurrenceB,p.edgeOccurrenceA);}
  const copies=new Map(view.pointCopies.map(c=>[c.id,c]));const wall=[];
  for(const item of occurrences.values()) {
    if(!chosen.has(item.face.id))continue;
    const mate=seam.get(item.id);
    const adjacent=mate ? [occurrences.get(mate)] : groups.get([item.a,item.b].sort().join('|')).filter(x=>x.id!==item.id);
    if(adjacent.some(x=>chosen.has(x.face.id)))continue;
    wall.push(item.id);
    for(const id of [item.a,item.b])snap.boardStates[copies.get(id).canonicalVertexId]=2;
  }
  const first=occurrences.get(wall[0]);
  snap.topologyPaths={BLACK:[{vertices:[copies.get(first.a).canonicalVertexId,copies.get(first.b).canonicalVertexId],edgeOccurrences:wall}]};
}
const narrow=make(true);
installFaceWalls(narrow,['u:0,2','d:0,2','u:6,2','d:6,2']);
const narrowResult=buildTopologyTerritoryDisplay(narrow);
for(const point of [[0.2,2.2],[6.8,2.2]]) assert.ok(narrowResult.some(p=>pointInDisplayPolygon(point,p.polygon)),`closed strip spans seam at ${point}`);
assert.ok(!narrowResult.some(p=>pointInDisplayPolygon([3.2,4.2],p.polygon)),'outside the small closed strip remains unpainted');
assert.equal(narrow.territories.BLACK.area,17,'face display does not alter score');
const whole=make(true);
install(whole,[[0,1],[0,2],[0,3],[0,4],[0,5],[0,6]]);
assert.equal(buildTopologyTerritoryDisplay(whole).length,0,'a nonseparating seam line cannot color the board');

// A closed torus has no privileged exterior. A narrow contractible strip
// spanning its seam is selected, while two exactly equal noncontractible sides
// are ambiguous and must not result in painting either half.
function closedTorus() {
  const snap=new GameEngine({boardDefinition:createSurfacePreset('torus',{width:6,height:6})}).getSnapshot();
  for(const id of Object.keys(snap.boardStates))snap.boardStates[id]=0;
  snap.territories={BLACK:{area:11,renderPoints:[],components:[]}};
  return snap;
}
const torusNarrow=closedTorus();
installFaceWalls(torusNarrow,['u:0,2','d:0,2','u:5,2','d:5,2']);
const torusShapes=buildTopologyTerritoryDisplay(torusNarrow);
assert.ok(torusShapes.some(p=>pointInDisplayPolygon([0.2,2.2],p.polygon)));
assert.ok(torusShapes.some(p=>pointInDisplayPolygon([5.8,2.2],p.polygon)));
assert.ok(!torusShapes.some(p=>pointInDisplayPolygon([3.2,4.2],p.polygon)),'closed surface is not swallowed');
const equalTorus=closedTorus(), equalCopies=new Map(equalTorus.topology.viewBoard.pointCopies.map(c=>[c.id,c]));
const half=equalTorus.topology.viewBoard.faces.filter(f=>f.copyIds.reduce((sum,id)=>sum+equalCopies.get(id).coordinate[0],0)/3 < 3).map(f=>f.id);
installFaceWalls(equalTorus,half);
assert.equal(buildTopologyTerritoryDisplay(equalTorus).length,0,'equal sides of a closed surface remain undecided');
const thirds=closedTorus(), thirdsCopies=new Map(thirds.topology.viewBoard.pointCopies.map(c=>[c.id,c]));
const thirdPaths=[];
for(let band=0;band<3;band++) {
  const ids=thirds.topology.viewBoard.faces.filter(f=>{
    const x=f.copyIds.reduce((sum,id)=>sum+thirdsCopies.get(id).coordinate[0],0)/3;
    return x>=2*band && x<2*(band+1);
  }).map(f=>f.id);
  installFaceWalls(thirds,ids); thirdPaths.push(...thirds.topologyPaths.BLACK);
}
thirds.topologyPaths.BLACK=thirdPaths;
assert.equal(buildTopologyTerritoryDisplay(thirds).length,0,'three equally sized torus bands cannot paint the entire surface');

// A real game can score a large enemy-free side of a closed surface. The
// half-surface tie policy belongs only to the face-dual display supplement;
// it must not erase already-counted discrete territory or change the score.
const largeDefinition=createSurfacePreset('torus',{width:8,height:8});
largeDefinition.startingVertices={BLACK:'v:1,1',WHITE:'v:2,2'};
const largeGame=new GameEngine({boardDefinition:largeDefinition});
assert.equal(largeGame.playMove('v:5,1').success,true);
assert.equal(largeGame.skipTurn().success,true);
assert.equal(largeGame.playMove('v:1,5').success,true);
const largeSnapshot=largeGame.getSnapshot();
const scoreBefore=structuredClone(largeGame.getScoreboard());
assert.equal(scoreBefore.BLACK.area,61);
const largeRegions=buildTopologyTerritoryDisplay(largeSnapshot).filter(part=>part.player==='BLACK');
assert.ok(largeRegions.some(part=>pointInDisplayPolygon([6.2,6.2],part.polygon)),
  'already-scored large region is displayed even beyond half the surface');
assert.deepEqual(largeGame.getScoreboard(),scoreBefore,'display preserves official score');

// Two separate closed six-face pockets: the enemy pocket stays empty without
// suppressing the independent safe pocket, despite a rejected outer contour.
const twinDef=createSurfacePreset('cylinder',{width:9,height:9}); twinDef.seamPairs=[];
const twins=new GameEngine({boardDefinition:twinDef}).getSnapshot();
for(const id of Object.keys(twins.boardStates)) twins.boardStates[id]=0;
twins.territories={BLACK:{area:0,renderPoints:[],components:[]}};
const twinView=twins.topology.viewBoard;
const centerAt=(x,y)=>twinView.pointCopies.find(c=>c.coordinate[0]===x&&c.coordinate[1]===y);
const blockedCenter=centerAt(2,2), safeCenter=centerAt(6,6);
const pockets=twinView.faces.filter(f=>f.copyIds.includes(blockedCenter.id)||f.copyIds.includes(safeCenter.id)).map(f=>f.id);
installFaceWalls(twins,pockets); twins.boardStates[blockedCenter.canonicalVertexId]=3;
const twinResult=buildTopologyTerritoryDisplay(twins);
assert.ok(twinResult.some(p=>pointInDisplayPolygon([6.1,6.1],p.polygon)), 'safe cavity survives a different enemy cavity');
assert.ok(!twinResult.some(p=>pointInDisplayPolygon([2.1,2.1],p.polygon)), 'enemy cavity stays unpainted');
const enemy=make(false);install(enemy,chain);
const enemyCopy=enemy.topology.viewBoard.pointCopies.find(c=>c.coordinate[0]===2 && c.coordinate[1]===2);
enemy.boardStates[enemyCopy.canonicalVertexId]=3;
assert.ok(!buildTopologyTerritoryDisplay(enemy).some(x=>x.player==='BLACK' && pointInDisplayPolygon([2,2],x.polygon)),'enemy is not filled');
console.log('PASS: open contours, missing face, seam locality, line, enemy and unchanged scores');
