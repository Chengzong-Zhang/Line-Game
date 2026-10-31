import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine, createCylinderBoardDefinition } from '../src/core.js';
import { applyAction } from '../src/state.js';
import { createLatestMoveTracker } from '../src/latest-moves.js';
import { layoutTopologyBoard, drawTopologyBoard } from '../src/topology-board.js';
import { buildSurfaceCells, createDepthRenderer } from '../src/topology/TopologySurface3D.js';
import { createSoftwareSurfaceRenderer } from '../src/topology-software-surface.js';
import { createTopologySetup, useTopologyPreset } from '../src/topology-setup.js';
import { uiHarness } from './ui-harness.mjs';
import { until } from './helpers.mjs';

const settings = { boardDefinition: createCylinderBoardDefinition({width:4,height:4}), rulesVersion:'surface-v1', playerCount:2 };
const moves = ['cv:1','cv:2','cv:4','cv:8'].map(vertexId => ({type:'move',vertexId}));
function replay(actions, opts=settings) { const engine = new GameEngine(opts); for (const action of actions) assert.equal(applyAction(engine, action).success, true); return engine.getSnapshot(); }

test('topology real cylinder: cut removes latest without fallback; cursor, restore and incomplete logs', () => {
  const tracker=createLatestMoveTracker();
  assert.deepEqual(tracker(settings,moves,replay(moves.slice(0,3)),3),{BLACK:'cv:4',WHITE:'cv:2'});
  assert.deepEqual(tracker(settings,moves,replay(moves)),{WHITE:'cv:8'});
  assert.deepEqual(tracker(settings,moves,replay(moves.slice(0,2)),2),{BLACK:'cv:1',WHITE:'cv:2'});
  assert.deepEqual(createLatestMoveTracker()(settings,JSON.parse(JSON.stringify(moves)),replay(moves)),{WHITE:'cv:8'});
  assert.deepEqual(tracker(settings,[],replay(moves)),{});
  assert.deepEqual(tracker(settings,moves.slice(0,3),replay(moves)),{});
  assert.deepEqual(tracker(settings,[{type:'move',vertexId:'bad'}],replay(moves)),{});
});

test('topology PASS clears its own marker, resignation clears only its owner', () => {
  const tracker=createLatestMoveTracker();
  const passed=[...moves.slice(0,2),{type:'skip'}];
  assert.deepEqual(tracker(settings,passed,replay(passed)),{WHITE:'cv:2'});
  const resigned=[...moves.slice(0,2),{type:'resign',player:'WHITE'}];
  assert.deepEqual(tracker(settings,resigned,replay(resigned)),{BLACK:'cv:1'});
});

test('three-player topology tracks every active seat', () => {
  const setup=useTopologyPreset(createTopologySetup(),'cylinder',{gridSize:5,playerCount:3});
  assert.equal(setup.ok,true);
  const opts={boardDefinition:setup.setup.definition,rulesVersion:'surface-v1',playerCount:3};
  const e=new GameEngine(opts), actions=[], expected={};
  for(let i=0;i<3;i++){const player=e.currentPlayer, id=e.getLegalMoves().find(move=>!move.isAttack).vertexId; assert.equal(e.playMove(id).success,true); actions.push({type:'move',vertexId:id}); expected[player]=id;}
  assert.deepEqual(createLatestMoveTracker()(opts,actions,e.getSnapshot()),expected);
});

test('2D marks all copies of a canonical seam node, respects the display switch and filters invalid owners', () => {
  const e=new GameEngine(settings); const layout=layoutTopologyBoard(e.getSnapshot(),{x:0,y:0,width:420,height:300});
  const entry=[...layout.copiesByCanonicalVertex].find(([,copies])=>copies.length>1); assert.ok(entry);
  const [id,copies]=entry; const s=e.getSnapshot();s.boardStates[id]=1;
  const draw=options=>{const calls=[], ctx=new Proxy({}, {get:(target,name)=>name in target?target[name]:(...args)=>{if(name==='stroke')calls.push(ctx.strokeStyle);},set:(target,name,value)=>(target[name]=value,true)}); drawTopologyBoard(ctx,s,layout,{...options,display:{territories:false,legalMoves:false,...options.display}});return calls.filter(color=>color==='#fffdf7').length;};
  const baseline=draw({lastMoves:{},display:{lastMove:false}});
  assert.equal(draw({lastMoves:{BLACK:id}})-baseline,copies.length);
  assert.equal(draw({lastMoves:{BLACK:id},display:{lastMove:false}}),baseline);
  assert.equal(draw({lastMoves:{WHITE:id}}),baseline);
  s.resignedPlayers=['BLACK'];assert.equal(draw({lastMoves:{BLACK:id}}),baseline);
});

test('3D data labels canonical copies and software renderer paints a visible ring', () => {
  const snap=replay(moves.slice(0,2)), marked={BLACK:'cv:1',WHITE:'cv:2'};
  const data=buildSurfaceCells(snap,1,marked);
  for(const [player,id] of Object.entries(marked)) {
    const selected=data.nodes.filter(node=>node.canonicalVertexId===id);
    assert.ok(selected.length);assert.ok(selected.every(node=>node.player===player&&node.latest));
  }
  assert.ok(buildSurfaceCells(snap,1,{}).nodes.every(node=>!node.latest));
  let pixels;const canvas={getContext:()=>({createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{pixels=image.data;}})};
  const renderer=createSoftwareSurfaceRenderer(canvas);
  renderer.draw({cells:[],lines:[],nodes:[{point:[0,0,1],player:'BLACK',latest:true}]},32,32,p=>p,1,{},1);
  const pixel=(x,y)=>Array.from(pixels.slice((y*32+x)*4,(y*32+x)*4+3));
  assert.deepEqual(pixel(21,16),[255,253,247]);assert.notDeepEqual(pixel(16,16),[255,253,247]);
});

test('WebGL renderer draws a white ring before the colored node', () => {
  const colors=[],sizes=[]; const gl=new Proxy({COMPILE_STATUS:1,LINK_STATUS:2,POINTS:3,TRIANGLES:4,LINES:5,
    getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,getUniformLocation:(_,name)=>name,
    createShader:()=>({}),createProgram:()=>({}),createBuffer:()=>({}),uniform4fv:(_,v)=>colors.push(v),uniform1f:(name,v)=>{if(name==='pointSize')sizes.push(v);}},
    {get:(target,name)=>name in target?target[name]:(()=>{})});
  const renderer=createDepthRenderer({getContext:()=>gl});assert.ok(renderer);
  renderer.draw({cells:[],lines:[],nodes:[{point:[0,0,1],player:'BLACK',latest:true}]},100,100,p=>p,1,{},1);
  assert.deepEqual(sizes,[13,8]);assert.ok(colors[0][0]>.99 && colors[0][1]>.98);
});


test('native topology game renders and restores markers through replay and undo', async () => {
  let count=0; const styles={};
  const ctx=new Proxy({measureText:text=>({width:String(text).length*8})}, {
    get:(target,name)=>name in target?target[name]:(...args)=>{if(name==='stroke' && styles.strokeStyle==='#fffdf7') count++;},
    set:(target,name,value)=>(styles[name]=value,target[name]=value,true),
  });
  const h=uiHarness({canvas:{getContext:()=>ctx}});
  try {
    await until(()=>h.app.session.snapshot&&!h.app.session.busy); const session=h.app.session;
    const opts={...settings,gridSize:5,startPlayer:'BLACK',boardShape:'custom',undoEnabled:true,undoMaxCount:3};
    assert.equal(await session.load(opts,[],{mode:'human',controllers:{BLACK:'human',WHITE:'human'}}),true);
    const check=async marks=>{
      count=0;await h.render();
      const snapshot=session.snapshot, layout=layoutTopologyBoard(snapshot,{x:0,y:0,width:420,height:300});
      const copies=id=>(layout.copiesByCanonicalVertex.get(id)??[]).length;
      const nodes=Object.entries(snapshot.boardStates).filter(([,state])=>state>=1&&state<=11&&state%2===1).reduce((sum,[id])=>sum+copies(id),0);
      assert.equal(count,nodes+marks.reduce((sum,id)=>sum+copies(id),0));
    };
    await check([]);
    assert.equal(await session.act(moves[0]),true);assert.equal(await session.act(moves[1]),true);await check(['cv:1','cv:2']);
    assert.equal(await session.restore(),true);await check(['cv:1','cv:2']);
    assert.equal(await session.replay(1),true);await check(['cv:1']);
    assert.equal(await session.exitReplay(),true);await check(['cv:1','cv:2']);
    session.resume();assert.equal(await session.undo(),true);await check(['cv:1']);
  } finally {h.app.dispose();}
});
