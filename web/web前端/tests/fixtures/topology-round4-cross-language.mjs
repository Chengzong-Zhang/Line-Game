import {createSurfacePreset} from '../../BoardPresets.js';
import {compileBoardOrThrow} from '../../BoardCompiler.js';
import {traceRay} from '../../BoardPaths.js';

const cases = [];
for (const name of ['cylinder','torus','mobius','klein-bottle','tetrahedron','sphere','cone']) {
  for (const strategy of name === 'cylinder' ? ['simple-rays-v2','simple-rays-v3'] : ['simple-rays-v3']) {
    const definition = createSurfacePreset(name, {gridSize:5});
    definition.topology.movementStrategy = strategy;
    const board = compileBoardOrThrow(definition), traces = [];
    for (const [rawIndex,raw] of definition.vertices.entries()) for (let directionIndex=0;directionIndex<6;directionIndex++) {
      const from = board.rawVertexToCanonical[raw.id];
      const direction = {atlasVertexId:raw.id,directionIndex};
      for (const position of [{coverageByPlayer:{}},
        {coverageByPlayer:{BLACK:[board.sampleIds[(rawIndex + directionIndex) % board.sampleIds.length]]}}]) {
        traces.push({from,direction,position,result:traceRay(board,position,from,direction)});
      }
    }
    cases.push({definition,boardHash:board.boardHash,vertexLinks:board.vertexLinks,
      eulerCharacteristic:board.eulerCharacteristic,boundaryCount:board.boundaryComponents.length,traces});
  }
}
console.log(JSON.stringify(cases));
