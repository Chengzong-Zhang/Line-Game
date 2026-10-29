import '../BoardView.js';
import { Renderer } from '../Renderer.js';
import { GameEngine } from '../GameEngine.js';
import { mountTopologySurface3D } from '../TopologySurface3D.js';
import { buildTopologyTerritoryDisplay,pointInDisplayPolygon } from '../TerritoryDisplay.js';
import {notchScreenshotFixture,tetrahedronScreenshotFixture,surfaceVisualFixture} from './fixtures/topology-round3-visual-fixtures.mjs';
const renderer=new Renderer(document.querySelector('#board'));
let surface;
function ordinary(shape){
  const engine=new GameEngine({gridSize:9,boardShape:shape,playerCount:2,rulesVersion:'territory-v3'});
  const lastMoves={};
  for(let i=0;i<2;i++){
    const player=engine.currentPlayer;
    const candidate=engine.getLegalMoves()[0];
    if(candidate){const point=candidate.point??candidate;const result=engine.playMove(point);if(result.success)lastMoves[player]=point;}
  }
  return {...engine.getSnapshot(),lastMoves};
}
function show(kind){
  try{
    surface?.destroy();surface=null;
    const snapshot=kind==='notch'?notchScreenshotFixture():kind==='tetrahedron'?tetrahedronScreenshotFixture():['triangle','hexagon'].includes(kind)?ordinary(kind):surfaceVisualFixture(kind);
    renderer.invalidate();renderer.render(snapshot);
    if(snapshot.isTopologyBoard)surface=mountTopologySurface3D(document.querySelector('#surface'),snapshot,{language:'zh'});
    const polygons=snapshot.isTopologyBoard?buildTopologyTerritoryDisplay(snapshot):[];
    const checks=kind==='notch'?`；蓝色覆盖下部 ${polygons.some(p=>p.player==='BLACK'&&pointInDisplayPolygon([4,5],p.polygon))}；覆盖盘外凹口 ${polygons.some(p=>p.player==='BLACK'&&pointInDisplayPolygon([4,6.8],p.polygon))}`:'';
    document.querySelector('#status').textContent=`已渲染 ${kind} · ${polygons.length} 个显示片${checks}`;
    for(const button of document.querySelectorAll('[data-fixture]'))button.setAttribute('aria-pressed',String(button.dataset.fixture===kind));
  }catch(error){document.querySelector('#status').textContent=`失败：${error.message}`;console.error(error);}
}
for(const button of document.querySelectorAll('[data-fixture]'))button.addEventListener('click',()=>show(button.dataset.fixture));
show('notch');
