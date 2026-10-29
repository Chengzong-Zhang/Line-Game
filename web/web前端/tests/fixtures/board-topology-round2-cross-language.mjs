import { addBoundaryVertex, closeBoundaryDraft, createBoardDraft, startBoundaryRing } from '../../BoardEditor.js';
import { createSurfacePreset } from '../../BoardPresets.js';
import { compileBoard } from '../../BoardCompiler.js';
function ring(d, points) { for (const p of points) { const r = addBoundaryVertex(d, p); if(!r.ok) throw Error(r.code); d=r.draft; } const r=closeBoundaryDraft(d); if(!r.ok) throw Error(r.code); return r.draft; }
let figure = ring(createBoardDraft(), [[2,1],[1,2],[1,1],[0,1],[1,0],[1,1]]).candidateDefinition;
figure.startingVertices = {BLACK:['v:1,0','v:2,1'], WHITE:'v:0,1'};
let separate = ring(createBoardDraft(), [[0,0],[1,0],[0,1]]);
separate = ring(startBoundaryRing(separate).draft, [[3,3],[4,3],[3,4]]).candidateDefinition;
separate.startingVertices = {BLACK:['v:0,0','v:1,0'], WHITE:'v:3,3'};
let tetra = createSurfacePreset('tetrahedron',{gridSize:5});
const cases = [figure,separate,tetra].map(definition => { const r=compileBoard(definition); if(!r.ok) throw Error(JSON.stringify(r.errors)); const b=r.value; return {definition:b.definition,boardHash:b.boardHash,vertexLinks:b.vertexLinks,specialVertices:b.specialVertices.map(v=>v.id).sort(),startingRoots:b.startingRoots,eulerCharacteristic:b.eulerCharacteristic}; });
console.log(JSON.stringify(cases));
