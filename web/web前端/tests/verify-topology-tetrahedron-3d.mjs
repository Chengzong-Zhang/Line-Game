import assert from "node:assert/strict";
import "../TopologyGameEngine.js";
import { GameEngine } from "../GameEngine.js";
import { createSurfacePreset } from "../BoardPresets.js";
import { compileBoard } from "../BoardCompiler.js";
import { createTopologyStartingDefinition } from "../TopologyStartingPoints.js";
import { computeTerritory } from "../SurfaceTerritory.js";
import { identifySurface, surfacePosition, buildSurfaceCells, mountTopologySurface3D } from "../TopologySurface3D.js";

const near=(a,b,message)=>assert.ok(a.every((v,i)=>Math.abs(v-b[i])<1e-9),`${message}: ${a} != ${b}`);
for(const size of [5,9,15]) {
  const definition=createSurfacePreset("tetrahedron",{gridSize:size});
  const result=compileBoard(definition); assert.ok(result.ok,JSON.stringify(result.errors));
  const board=result.value, surface=identifySurface(definition);
  assert.equal(surface.kind,"tetrahedron");
  const m=surface.width/2;
  const vertices=[[0,0],[m,0],[0,m],[m,m]].map(p=>surfacePosition(surface,p,{}));
  const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  const edge=distance(vertices[0],vertices[1]);
  for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) assert.ok(Math.abs(distance(vertices[i],vertices[j])-edge)<1e-9,"regular tetrahedron has six equal edges");
  const rawVertices=new Map(definition.vertices.map(v=>[v.id,v.coordinate]));
  for(const face of definition.faces) {
    const mapped=face.vertices.map(id=>surfacePosition(surface,rawVertices.get(id),{}));
    for(let i=0;i<3;i++) assert.ok(Math.abs(distance(mapped[i],mapped[(i+1)%3])-edge/m)<1e-9,"every atomic triangle remains equilateral");
  }
  const copiesByCanonical=new Map();
  for(const copy of board.atlas.pointCopies) {
    const prior=copiesByCanonical.get(copy.canonicalVertexId);
    const point=surfacePosition(surface,copy.coordinate,{});
    if(prior) near(point,prior,"all canonical seam copies coincide"); else copiesByCanonical.set(copy.canonicalVertexId,point);
  }
  assert.ok(board.atlas.pointCopies.length>copiesByCanonical.size,"fixture has actual glued copies");
  // Interior coordinates agree continuously on both sides of each fold.
  for(let i=0;i<=m;i++) {
    const epsilon=1e-7, p=[i,m-i];
    const a=surfacePosition(surface,p,{}), b=surfacePosition(surface,[p[0]+epsilon,p[1]+epsilon],{});
    assert.ok(distance(a,b)<1e-6,"central fold is continuous");
  }
  const changed=structuredClone(definition);
  changed.startingVertices={BLACK:["v:0,0",`v:${m},0`],WHITE:`v:0,${m}`};
  assert.equal(identifySurface(changed).kind,"tetrahedron","start layout does not determine the embedding");
  const corrupt=structuredClone(definition); corrupt.seamPairs[0].endpointMap.reverse();
  assert.equal(identifySurface(corrupt).kind,"atlas","changed seam cannot masquerade as the preset");
  const corruptFace=structuredClone(definition); corruptFace.faces.pop();
  assert.equal(identifySurface(corruptFace).kind,"atlas","missing face cannot masquerade as the preset");
}

const definition=createSurfacePreset("tetrahedron",{gridSize:9});
const compiled=compileBoard(definition).value;
const multistart=createTopologyStartingDefinition(compiled,{playerCount:2,countPerPlayer:2,mode:"default"});
const game=new GameEngine({boardDefinition:multistart});
assert.equal(identifySurface(game.boardDefinition).kind,"tetrahedron");
const move=game.getLegalMoves()[0]; assert.ok(move); assert.equal(game.playMove(move.vertexId).success,true);
const snapshot=game.getSnapshot();
const model=buildSurfaceCells(snapshot,2);
assert.equal(model.surface.kind,"tetrahedron");
assert.ok(model.cells.length && model.lines.some(line=>line.player==="BLACK"),"real triangular faces and played lines reach the 3D model");
for(const root of game.initialRoots.BLACK) {
  const copy=snapshot.topology.viewBoard.pointCopies.find(p=>p.canonicalVertexId===root);
  const position=surfacePosition(model.surface,copy.coordinate,{});
  assert.ok(model.nodes.some(node=>node.player==="BLACK" && node.start && node.point.every((v,i)=>Math.abs(v-position[i])<1e-9)),"every BLACK root is marked");
}
for(const line of model.lines) assert.ok(distance3(...line.points)<1,"every mesh/path segment remains local");
function distance3(a,b) {return Math.hypot(...a.map((v,i)=>v-b[i]));}
// Use a real canonical flood component to test coloring on folded faces.
const all=game.compiledBoard.sampleIds, adj=game.compiledBoard.canonicalAdjacency;
const center=all.find(id=>adj[id].length===6 && all.some(e=>e!==id && !adj[id].includes(e)));
const ring=adj[center], enemy=all.find(id=>id!==center && !ring.includes(id));
const territory=computeTerritory(game.compiledBoard,{ownedSampleIdsByPlayer:{BLACK:ring,WHITE:[enemy]}},"BLACK");
assert.ok(territory.enclosedSampleIds.includes(center));
const colored=structuredClone(snapshot);
colored.territories={BLACK:{area:territory.area,renderPoints:[...territory.ownedSampleIds,...territory.enclosedSampleIds],components:territory.components}};
assert.ok(buildSurfaceCells(colored,2).cells.some(cell=>cell.player==="BLACK"),"formal interior colors the folded mesh");

// Exercise the real viewer's drag and keyboard paths, recording projected
// canvas geometry before and after rotation rather than only invoking handlers.
const saved={document:globalThis.document, matchMedia:globalThis.matchMedia, requestAnimationFrame:globalThis.requestAnimationFrame, cancelAnimationFrame:globalThis.cancelAnimationFrame};
const projected=[];
const ctx=new Proxy({}, {get:(target,key)=>target[key]??((...args)=>{if(key==="moveTo")projected.push(args);}),set:(target,key,value)=>(target[key]=value,true)});
class Element {constructor(){this.style={};this.children=[];this.events=new Map();} append(...x){this.children.push(...x);} setAttribute(){} addEventListener(k,v){this.events.set(k,v);} removeEventListener(k){this.events.delete(k);} getContext(){return ctx;} getBoundingClientRect(){return {width:400,height:320};} setPointerCapture(){} remove(){}}
globalThis.document={createElement:()=>new Element()};
globalThis.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
globalThis.requestAnimationFrame=()=>1; globalThis.cancelAnimationFrame=()=>{};
try {
  const container=new Element(), viewer=mountTopologySurface3D(container,snapshot,{language:"en"});
  const [label,canvas]=container.children[0].children;
  assert.match(label.textContent,/Tetrahedron/);
  const first=projected.slice(); projected.length=0;
  canvas.events.get("pointerdown")({clientX:10,clientY:10,pointerId:1});
  canvas.events.get("pointermove")({clientX:60,clientY:30,pointerId:1});
  canvas.events.get("pointerup")({pointerId:1});
  assert.ok(projected.length); assert.notDeepEqual(projected,first,"drag changes the visible projection");
  projected.length=0; canvas.events.get("keydown")({key:"ArrowLeft",preventDefault(){}});
  assert.ok(projected.length,"keyboard rotation redraws the viewer");
  viewer.update(snapshot,{language:"zh"}); assert.match(label.textContent,/三角锥/);
  viewer.destroy();
} finally {for(const [k,v] of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
console.log("tetrahedron 3D: PASS (5/9/15 exact seams, regular tetrahedron, tamper refusal, roots, paths, color and rotation)");
