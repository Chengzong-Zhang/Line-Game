import assert from 'node:assert/strict';
import { createSurfacePreset } from '../BoardPresets.js';
import { compileBoardOrThrow } from '../BoardCompiler.js';
import { createBoardDraft, addBoundaryVertex, closeBoundaryDraft } from '../BoardEditor.js';
import { generateBoard } from '../RandomBoard.js';
import { enumerateConnections, traceRay, RayStopReason } from '../BoardPaths.js';
import { identifySurface, surfacePosition, resolveSurfaceSamplePlayer } from '../TopologySurface3D.js';
import { makeTriangularPatchDefinition } from './fixtures/board-topology-v1-fixtures.mjs';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';

const compile = d => compileBoardOrThrow(d);
assert.equal(resolveSurfaceSamplePlayer([{player:'BLACK'},{player:'BLACK'}]),'BLACK');
assert.equal(resolveSurfaceSamplePlayer([{player:'BLACK'},{player:'WHITE'}]),null);
let draft = createBoardDraft();
for (const v of [[0,0],[1,0],[2,0],[2,1],[2,2],[1,2],[0,2],[0,1]]) draft = addBoundaryVertex(draft,v).draft;
draft = closeBoundaryDraft(draft).draft;
const random = generateBoard({gridSize:9}, 'round3-cross-language');
assert.equal(random.ok,true);
const fixtures = ['cone','sphere','tetrahedron','cylinder','torus','mobius'].map(name=>createSurfacePreset(name,{gridSize:9}));
fixtures.push(draft.candidateDefinition,random.definition);
if (process.argv.includes('--fixtures-json')) {
  console.log(JSON.stringify(fixtures.map(d=>{const b=compile(d);return {definition:b.definition,boardHash:b.boardHash,vertexLinks:b.vertexLinks,eulerCharacteristic:b.eulerCharacteristic,boundaryCount:b.boundaryComponents.length};})));
  process.exit(0);
}

for (const n of [5,6,7,8,9,10,11,12,13,14,15]) for(const name of ['cone','sphere']) {
  const definition=createSurfacePreset(name,{gridSize:n}), board=compile(definition);
  assert.equal(definition.topology.movementStrategy,'simple-rays-v3');
  assert.equal(board.eulerCharacteristic,name==='cone'?1:2);
  assert.equal(board.boundaryComponents.length,name==='cone'?1:0);
  assert.ok(board.vertexLinks.every(link=>link.manifold));
  assert.ok(board.edgeClasses.every(edge=>edge.canonicalVertices?.[0] !== edge.canonicalVertices?.[1]));
  const poles=board.vertexLinks.filter(v=>v.kind==='cycle'&&v.incidentEdgeClassCount!==6);
  assert.equal(poles.length,name==='cone'?1:4);
  for (const pole of poles) for (const neighbor of board.canonicalAdjacency[pole.id]) {
    const outgoing=enumerateConnections(board,{coverageByPlayer:{BLACK:[neighbor]}},pole.id,'BLACK');
    assert.ok(outgoing.some(p=>p.endVertexId===neighbor),`${name} ${n} pole exit ${pole.id} ${neighbor}`);
    const incoming=enumerateConnections(board,{coverageByPlayer:{BLACK:[pole.id]}},neighbor,'BLACK');
    assert.ok(incoming.some(p=>p.endVertexId===pole.id),`${name} ${n} pole entry`);
    let stopped=false;
    for(const raw of board.canonicalVertices.find(v=>v.id===neighbor).sourceVertexIds) for(let dir=0;dir<6;dir++) {
      const ray=traceRay(board,{coverageByPlayer:{}},neighbor,{atlasVertexId:raw,directionIndex:dir});
      if(ray.vertices.at(-1)===pole.id && ray.stopReason===RayStopReason.SPECIAL_VERTEX) stopped=true;
    }
    assert.ok(stopped,'ray stops at pole rather than turning through it');
  }
  const shape=identifySurface(board.definition); assert.equal(shape.kind,name);
  const coords=new Map(board.definition.vertices.map(v=>[v.id,v.coordinate]));
  for(const v of board.canonicalVertices) {
    const points=v.sourceVertexIds.map(id=>surfacePosition(shape,coords.get(id),{}));
    for(const p of points) {
      assert.ok(p.every(Number.isFinite));
      if(name==='sphere') assert.ok(Math.abs(Math.hypot(...p)-1)<1e-9);
      assert.ok(Math.hypot(...p.map((x,i)=>x-points[0][i]))<1e-9,'all seam copies coincide in 3D');
    }
  }
  if(name==='cone') for(const id of board.realBoundarySampleIds) {
    const raw=board.canonicalVertices.find(v=>v.id===id).sourceVertexIds[0];
    assert.ok(Math.abs(surfacePosition(shape,coords.get(raw),{})[1]+1)<1e-9,'cone base is a real ring');
  }
  const game=new GameEngine({boardDefinition:definition});
  for(let i=0;i<4;i++) {const moves=game.getLegalMoves();if(!moves.length)break;assert.equal(game.playMove(moves[0].vertexId).success,true);}
  const saved=game.encodeTopologyState(), restored=new GameEngine({boardDefinition:game.boardDefinition});
  assert.equal(restored.restoreTopologyState(saved),true);
  assert.deepEqual(restored.getTopologyRuleState(),game.getTopologyRuleState());
}

// The old rule connects through friendly coverage; v2 rejects its real
// crossing/intermediate-node route, without using any rendering predicate.
const definition=makeTriangularPatchDefinition({width:5,height:4,startingVertices:{BLACK:'v:0,1',WHITE:'v:2,3'}});
const v1=compile(definition), newDef=structuredClone(definition);newDef.topology.movementStrategy='simple-rays-v2';const v2=compile(newDef);
const id=(b,x,y)=>b.rawVertexToCanonical[`v:${x},${y}`];
const routes=b=>enumerateConnections(b,{coverageByPlayer:{BLACK:[id(b,0,1),id(b,1,1),id(b,2,1)]},nodesByPlayer:{BLACK:[id(b,0,1),id(b,2,1)]}},id(b,4,1),'BLACK');
assert.ok(routes(v1).some(p=>p.endVertexId===id(v1,0,1)));
assert.ok(!routes(v2).some(p=>p.endVertexId===id(v2,0,1)));
assert.ok(routes(v2).some(p=>p.endVertexId===id(v2,2,1)));
// Cut exception: placing at an enemy line endpoint remains allowed even if
// the resulting position creates a three-node adjacency chain.
const game=new GameEngine({boardDefinition:newDef}); const at=(x,y)=>game._canonicalId([x,y]);
game._setState(at(4,1),game._getPlayerStates('BLACK').node);
game._setState(at(2,2),game._getPlayerStates('WHITE').node);
for(const [owner,start,end] of [['BLACK',at(4,1),at(0,1)],['WHITE',at(2,2),at(2,3)]]) {
 const p=enumerateConnections(game.compiledBoard,{coverageByPlayer:{[owner]:[end]}},start,owner)[0]; assert.ok(p);game.topologyPaths[owner].set(p.pathId,p);
}
game._rebuildTopology(); assert.equal(game._checkThreePointLimitation(at(2,1),'WHITE'),false);
assert.equal(game._addNode(at(2,1),'WHITE'),true);assert.equal(game.topologyPaths.BLACK.size,0);
for(const d of fixtures) assert.equal(d.topology.movementStrategy,'simple-rays-v3');
console.log('round3 poles and paths: PASS (5-15 sizes, links, boundaries, all pole exits, no turn through pole, seam-coincident geometry, v1/v2 crossing, cut and restoration)');
