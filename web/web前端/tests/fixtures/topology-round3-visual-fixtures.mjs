import '../../TopologyGameEngine.js';
import { GameEngine } from '../../GameEngine.js';
import { createSurfacePreset } from '../../BoardPresets.js';
import { createBoardDraft, addBoundaryVertex, closeBoundaryDraft } from '../../BoardEditor.js';
import { computeTerritory } from '../../SurfaceTerritory.js';

// Display regressions reconstructed from the screenshots, not claimed to be
// recovered move histories. The rule tests separately exercise legal moves.
function unitChain(corners, closed = false) {
  const result = [];
  const end = closed ? corners.length : corners.length - 1;
  for (let i = 0; i < end; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const distance = Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]),Math.abs(b[0]-a[0]+b[1]-a[1]));
    for (let step = 0; step < distance; step++) result.push(a.map((v,j)=>v+(b[j]-v)*step/distance));
  }
  if (!closed) result.push(corners.at(-1));
  if (result.some(p=>!p.every(Number.isInteger))) throw new Error('Fixture must use lattice directions');
  return result;
}

function install(game, specifications) {
  const snapshot = game.getSnapshot(), view = snapshot.topology.viewBoard;
  const at = (p) => view.pointCopies.find(copy=>copy.coordinate[0]===p[0] && copy.coordinate[1]===p[1]);
  const ownership = {};
  snapshot.topologyPaths = {}; snapshot.lastMoves = {};
  for (const id of Object.keys(snapshot.boardStates)) snapshot.boardStates[id] = 0;
  for (const [player, spec] of Object.entries(specifications)) {
    const nodeState = player==='BLACK' ? 1 : 3;
    const paths = spec.chains.map((chain,index)=>{
      const copies = unitChain(chain).map(p=>at(p));
      if (copies.some(c=>!c)) throw new Error('Fixture leaves the atlas');
      for (const copy of copies) snapshot.boardStates[copy.canonicalVertexId] = nodeState+1;
      return {pathId:`visual:${player}:${index}`,vertices:copies.map(c=>c.canonicalVertexId),edgeOccurrences:copies.slice(1).map((copy,i)=>{
        const edge = view.displayEdges.find(e=>e.copyIds.includes(copy.id)&&e.copyIds.includes(copies[i].id));
        if (!edge) throw new Error('Fixture lacks a real edge');
        return edge.id.replace(/^guide:/,'');
      })};
    });
    snapshot.topologyPaths[player] = paths;
    for (const point of spec.nodes) snapshot.boardStates[at(point).canonicalVertexId] = nodeState;
    snapshot.lastMoves[player] = at(spec.nodes.at(-1)).canonicalVertexId;
    snapshot.initialPositions[player] = at(spec.nodes[0]).canonicalVertexId;
    snapshot.topology.startingRoots[player] = [at(spec.nodes[0]).canonicalVertexId];
  }
  for (const [player, state] of [['BLACK',1],['WHITE',3]]) ownership[player] = Object.keys(snapshot.boardStates).filter(id=>[state,state+1].includes(snapshot.boardStates[id]));
  snapshot.territories = Object.fromEntries(Object.keys(ownership).map(player=>{
    const territory=computeTerritory(game.compiledBoard,{ownedSampleIdsByPlayer:ownership},player);
    return [player,{...territory,renderPoints:[...territory.ownedSampleIds,...territory.enclosedSampleIds]}];
  }));
  snapshot.legalMoves=[];
  return snapshot;
}

export function notchScreenshotFixture() {
  let draft=createBoardDraft();
  const corners=[[0,0],[8,0],[8,7],[5,7],[5,6],[3,6],[3,7],[0,7]];
  for(const point of unitChain(corners,true)) {
    const result=addBoundaryVertex(draft,point);
    if(!result.ok) throw new Error(result.error?.message??'Boundary step failed');
    draft=result.draft;
  }
  const closed=closeBoundaryDraft(draft);
  if(!closed.ok)throw new Error('Boundary closure failed');
  const definition=closed.definition;
  definition.startingVertices={BLACK:'v:0,7',WHITE:'v:0,0'};
  const game=new GameEngine({boardDefinition:definition});
  return install(game,{
    BLACK:{chains:[[[0,7],[3,4],[8,4],[8,6],[7,7]]],nodes:[[0,7],[3,4],[8,4],[8,6],[7,7]]},
    WHITE:{chains:[[[0,0],[6,0],[3,3],[0,3],[0,0]]],nodes:[[0,0],[0,3],[3,3],[6,0]]},
  });
}

export function tetrahedronScreenshotFixture() {
  const definition=createSurfacePreset('tetrahedron',{gridSize:9});
  // The old crossing screenshot is retained as a legacy display fixture.
  definition.topology.movementStrategy='simple-rays-v1';
  const game=new GameEngine({boardDefinition:definition});
  return install(game,{
    BLACK:{chains:[[[0,0],[8,0]]],nodes:[[0,0],[4,0],[3,0]]},
    WHITE:{chains:[[[0,4],[3,1],[4,1],[4,4],[0,4]],[[3,1],[3,5]],[[4,1],[0,5]],[[0,3],[5,3]]],nodes:[[0,4],[4,1],[4,4],[3,1]]},
  });
}

export function surfaceVisualFixture(kind) {
  const definition=createSurfacePreset(kind,{gridSize:9});
  const game=new GameEngine({boardDefinition:definition});
  const positions=kind==='cone'
    ? {BLACK:{chains:[[[1,0],[1,2],[3,2],[3,0]]],nodes:[[1,0],[1,2],[3,2],[3,0]]}}
    : {BLACK:{chains:[[[0,3],[2,1],[3,1],[3,3],[0,3]]],nodes:[[0,3],[2,1],[3,1],[3,3]]}};
  const whiteRoot=game.getSnapshot().topology.viewBoard.pointCopies.find(copy=>copy.canonicalVertexId===game.initialPositions.WHITE);
  positions.WHITE={chains:[],nodes:[whiteRoot.coordinate]};
  return install(game,positions);
}
