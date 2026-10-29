import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { computeTerritory } from '../SurfaceTerritory.js';
import { buildTopologyTerritoryDisplay, pointInDisplayPolygon } from '../TerritoryDisplay.js';
import { buildSurfaceCells, resolveSurfaceSamplePlayer } from '../TopologySurface3D.js';
import { buildTopologyTerritoryDisplay as buildMiniDisplay } from '../../../wechat/minigame/src/topology/TerritoryDisplay.js';
import { buildSurfaceCells as buildMiniSurfaceCells } from '../../../wechat/minigame/src/topology/TopologySurface3D.js';

// Screenshot-inspired reconstruction only; the original game history is not available.
function fixture() {
  const game = new GameEngine({boardDefinition:createSurfacePreset('mobius',{width:7,height:7})});
  const snapshot=game.getSnapshot(), view=snapshot.topology.viewBoard;
  const at=([x,y])=>view.pointCopies.find(c=>c.coordinate[0]===x && c.coordinate[1]===y);
  for(const id of Object.keys(snapshot.boardStates))snapshot.boardStates[id]=0;
  const paths=[[[0,3],[3,0],[3,3],[0,3]],[[0,0],[0,3]],[[0,0],[6,0]],[[3,3],[4,2]],[[3,3],[3,4]],[[3,3],[0,6]],[[0,5],[0,6]]];
  snapshot.topologyPaths={BLACK:paths.map((corners,index)=>{
    const coordinates=[];
    for(let i=0;i+1<corners.length;i++) {
      const a=corners[i],b=corners[i+1],n=Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));
      for(let k=0;k<n;k++)coordinates.push(a.map((v,j)=>v+(b[j]-v)*k/n));
    }
    coordinates.push(corners.at(-1));
    const copies=coordinates.map(at); assert.ok(copies.every(Boolean));
    for(const c of copies)snapshot.boardStates[c.canonicalVertexId]=2;
    for(const p of corners)snapshot.boardStates[at(p).canonicalVertexId]=1;
    return {pathId:`approx:${index}`,vertices:copies.map(c=>c.canonicalVertexId),edgeOccurrences:copies.slice(1).map((c,i)=>{
      const edge=view.displayEdges.find(e=>e.copyIds.includes(c.id)&&e.copyIds.includes(copies[i].id));
      assert.ok(edge,`real edge ${coordinates[i]} to ${coordinates[i+1]}`); return edge.id.replace(/^guide:/,'');
    })};
  })};
  snapshot.topologyPaths.WHITE=[[[4,1],[5,1],[5,3],[7,3]],[[5,3],[4,4]],[[6,3],[3,6],[1,6]],[[6,3],[6,6],[3,6]]].map((corners,index)=>{
    const coordinates=[];
    for(let i=0;i+1<corners.length;i++) {
      const a=corners[i],b=corners[i+1],n=Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));
      for(let k=0;k<n;k++)coordinates.push(a.map((v,j)=>v+(b[j]-v)*k/n));
    }
    coordinates.push(corners.at(-1));
    const points=coordinates.map(at);assert.ok(points.every(Boolean));
    for(const c of points)snapshot.boardStates[c.canonicalVertexId]=4;
    for(const p of corners)snapshot.boardStates[at(p).canonicalVertexId]=3;
    return {pathId:`approx:white:${index}`,vertices:points.map(c=>c.canonicalVertexId),edgeOccurrences:points.slice(1).map((c,i)=>{
      const edge=view.displayEdges.find(e=>e.copyIds.includes(c.id)&&e.copyIds.includes(points[i].id));
      assert.ok(edge,`real white edge ${coordinates[i]} to ${coordinates[i+1]}`);return edge.id.replace(/^guide:/,'');
    })};
  });
  const ownership={BLACK:Object.keys(snapshot.boardStates).filter(id=>[1,2].includes(snapshot.boardStates[id])),WHITE:Object.keys(snapshot.boardStates).filter(id=>[3,4].includes(snapshot.boardStates[id]))};
  snapshot.territories=Object.fromEntries(['BLACK','WHITE'].map(player=>{
    const t=computeTerritory(game.compiledBoard,{ownedSampleIdsByPlayer:ownership},player);
    return [player,{...t,renderPoints:[...t.ownedSampleIds,...t.enclosedSampleIds]}];
  }));
  return snapshot;
}
const snap=fixture(), view=snap.topology.viewBoard, copies=new Map(view.pointCopies.map(c=>[c.id,c]));
const before=structuredClone(snap.territories), regions=buildTopologyTerritoryDisplay(snap);
let inside=0;
for(const face of view.faces) {
  const center=[0,1].map(axis=>face.copyIds.reduce((s,id)=>s+copies.get(id).coordinate[axis],0)/3);
  if(center[0]+center[1]<3) {
    inside++;
    assert.ok(regions.some(p=>p.player==='BLACK' && p.faceId===face.id && pointInDisplayPolygon(center,p.polygon)), `missing main triangle ${face.id} at ${center}`);
  }
}
assert.equal(inside,9);
for(const point of [[4.3,3.3],[2.3,5.3],[5.3,5.3]]) {
  assert.ok(!regions.some(p=>p.player==='BLACK' && pointInDisplayPolygon(point,p.polygon)), `outside remains empty at ${point}`);
}
assert.ok(regions.every(p=>p.polygon.reduce((s,q,i)=>s+q[0]*p.polygon[(i+1)%p.polygon.length][1]-q[1]*p.polygon[(i+1)%p.polygon.length][0],0)>1e-9), 'all Canvas pieces have the same winding');
const missing=structuredClone(snap);
missing.topology.viewBoard.faces=missing.topology.viewBoard.faces.filter(f=>f.id!=='d:0,0');
assert.ok(!buildTopologyTerritoryDisplay(missing).some(p=>p.player==='BLACK' && pointInDisplayPolygon([2/3,2/3],p.polygon)), 'removed face remains a hole');
const blocked=structuredClone(snap), enemy=blocked.topology.viewBoard.pointCopies.find(c=>c.coordinate[0]===1 && c.coordinate[1]===1);
blocked.boardStates[enemy.canonicalVertexId]=3;
assert.ok(!buildTopologyTerritoryDisplay(blocked).some(p=>p.player==='BLACK' && pointInDisplayPolygon([1.05,1.05],p.polygon)), 'enemy inside the triangle is not painted');

// Reverse every face while preserving the identity of each undirected edge.
const reversed=structuredClone(snap), reverseOccurrence=id=>id.replace(/:([012])$/,(_,i)=>`:${[1,0,2][Number(i)]}`);
for(const face of reversed.topology.viewBoard.faces) { face.copyIds.reverse(); face.canonicalVertexIds.reverse(); }
for(const edge of reversed.topology.viewBoard.displayEdges) edge.id=reverseOccurrence(edge.id);
for(const pair of reversed.topology.viewBoard.seamPairs) { pair.edgeOccurrenceA=reverseOccurrence(pair.edgeOccurrenceA);pair.edgeOccurrenceB=reverseOccurrence(pair.edgeOccurrenceB); }
for(const paths of Object.values(reversed.topologyPaths)) for(const p of paths) p.edgeOccurrences=p.edgeOccurrences.map(reverseOccurrence);
const reverseRegions=buildTopologyTerritoryDisplay(reversed);
for(const face of reversed.topology.viewBoard.faces) {
  const center=[0,1].map(axis=>face.copyIds.reduce((s,id)=>s+copies.get(id).coordinate[axis],0)/3);
  if(center[0]+center[1]<3) assert.ok(reverseRegions.some(p=>p.player==='BLACK'&&p.faceId===face.id&&pointInDisplayPolygon(center,p.polygon)),`reverse winding ${face.id}`);
}
const data=buildSurfaceCells(snap,3);
for(const cell of data.cells) {
  const matches=regions.filter(p=>p.faceId===cell.faceId && pointInDisplayPolygon(cell.atlasCenter,p.polygon));
  assert.equal(cell.player,resolveSurfaceSamplePlayer(matches));
}
assert.deepEqual(buildMiniDisplay(structuredClone(snap)),regions,'native and web use the same displayed pieces');
const miniData=buildMiniSurfaceCells(structuredClone(snap),3);
assert.deepEqual(miniData.cells.map(c=>[c.faceId,c.atlasCenter,c.player]),data.cells.map(c=>[c.faceId,c.atlasCenter,c.player]),'native and web sample the same 3D territory');
assert.deepEqual(snap.territories,before);
// A separately constructed legal game reproduces the same real-boundary
// enclosure; it is not a claimed replay of the screenshot.
const definition=createSurfacePreset('mobius',{width:7,height:7});
definition.startingVertices={BLACK:'v:0,0',WHITE:'v:6,6'};
const game=new GameEngine({boardDefinition:definition});
for(const action of ['v:0,3','pass','v:3,0','pass','v:3,3']) {
  assert.equal((action==='pass'?game.skipTurn():game.playMove(action)).success,true,`legal ${action}`);
}
const score=structuredClone(game.getScoreboard()), live=game.getSnapshot();
const liveRegions=buildTopologyTerritoryDisplay(live);
for(const face of live.topology.viewBoard.faces) {
  const liveCopies=new Map(live.topology.viewBoard.pointCopies.map(c=>[c.id,c]));
  const center=[0,1].map(axis=>face.copyIds.reduce((s,id)=>s+liveCopies.get(id).coordinate[axis],0)/3);
  if(center[0]+center[1]<3) assert.ok(liveRegions.some(p=>p.player==='BLACK'&&p.faceId===face.id&&pointInDisplayPolygon(center,p.polygon)),`legal action triangle ${face.id}`);
}
assert.deepEqual(game.getScoreboard(),score);
console.log('PASS: screenshot-inspired branched triangle and 2D/3D consistency');
