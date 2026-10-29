import '../../TopologyGameEngine.js';
import { GameEngine } from '../../GameEngine.js';
import { createSurfacePreset } from '../../BoardPresets.js';
import { computeTerritory } from '../../SurfaceTerritory.js';

// Approximation of the screenshot's sphere net, not a recovered history.
// The three blue physical paths have explicitly selected unit occurrences.
export function sphereSeamTriangleFixture(kind = 'sphere') {
  const game = new GameEngine({boardDefinition:createSurfacePreset(kind,{gridSize:9})});
  const snapshot = game.getSnapshot(), view = snapshot.topology.viewBoard;
  const at = ([x,y]) => view.pointCopies.find(c=>c.coordinate[0]===x && c.coordinate[1]===y);
  for (const id of Object.keys(snapshot.boardStates)) snapshot.boardStates[id]=0;
  const chains = {
    BLACK: [[[4,0],[8,0]],[[4,0],[0,4]],[[0,4],[0,8]]],
    WHITE: [[[2,4],[4,4]]],
  };
  snapshot.topologyPaths = {};
  for (const [player,paths] of Object.entries(chains)) {
    const state = player === 'BLACK' ? 1 : 3;
    snapshot.topologyPaths[player] = paths.map(([a,b],index) => {
      const n=Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));
      const points=Array.from({length:n+1},(_,i)=>at([a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n]));
      for (const point of points) snapshot.boardStates[point.canonicalVertexId]=state+1;
      snapshot.boardStates[points[0].canonicalVertexId]=state;
      snapshot.boardStates[points.at(-1).canonicalVertexId]=state;
      return {pathId:`approx:${player}:${index}`, vertices:points.map(c=>c.canonicalVertexId), edgeOccurrences:points.slice(1).map((p,i)=>{
        const edge=view.displayEdges.find(e=>e.copyIds.includes(p.id)&&e.copyIds.includes(points[i].id));
        if (!edge) throw new Error('Fixture path must follow a true atlas edge');
        return edge.id.replace(/^guide:/,'');
      })};
    });
  }
  const ownership = Object.fromEntries([['BLACK',1],['WHITE',3]].map(([player,state])=>[player,
    Object.keys(snapshot.boardStates).filter(id=>[state,state+1].includes(snapshot.boardStates[id]))]));
  snapshot.territories = Object.fromEntries(Object.keys(ownership).map(player=>{
    const territory = computeTerritory(game.compiledBoard,{ownedSampleIdsByPlayer:ownership},player);
    return [player,{...territory,renderPoints:[...territory.ownedSampleIds,...territory.enclosedSampleIds]}];
  }));
  return snapshot;
}
