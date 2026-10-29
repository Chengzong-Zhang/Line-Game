import '../BoardView.js?v=20261029-topology-round5';
import '../TopologyGameEngine.js?v=20261029-topology-round5';
import {Renderer} from '../Renderer.js?v=20261029-topology-round5';
import {GameEngine} from '../GameEngine.js?v=20261029-topology-round5';
import {createSurfacePreset} from '../BoardPresets.js?v=20261029-topology-round5';
import {mountTopologySurface3D} from '../TopologySurface3D.js?v=20261029-topology-round5';
import {buildTopologyTerritoryDisplay,pointInDisplayPolygon} from '../TerritoryDisplay.js?v=20261029-topology-round5';
import {notchScreenshotFixture} from './fixtures/topology-round3-visual-fixtures.mjs';
import {sphereSeamTriangleFixture} from './fixtures/topology-round4-territory-fixtures.mjs';
const renderer=new Renderer(document.querySelector('#board'));
let surface;
const inside=(pieces,p)=>pieces.some(s=>s.player==='BLACK'&&pointInDisplayPolygon(p,s.polygon));
function prepare(kind){
  if(kind==='notch')return {snapshot:notchScreenshotFixture(),label:'凸包内的有效棋盘继续填色；盘外凹口留空'};
  if(kind==='hole'){
    const snapshot=notchScreenshotFixture(),view=snapshot.topology.viewBoard;
    const byId=new Map(view.pointCopies.map(c=>[c.id,c]));
    const holeFaces=view.faces.filter(f=>{const p=f.copyIds.map(id=>byId.get(id).coordinate);const center=[0,1].map(a=>p.reduce((s,x)=>s+x[a],0)/3);return center[0]>4&&center[0]<6&&center[1]>4&&center[1]<5;});
    const groups=new Map();
    for(const f of holeFaces)for(let i=0;i<3;i++){const ids=[f.copyIds[i],f.copyIds[(i+1)%3]],key=ids.slice().sort().join('|');groups.set(key,{ids,count:(groups.get(key)?.count??0)+1});}
    for(const {ids,count}of groups.values())if(count===1)view.realBoundarySegments.push({id:'hole:'+ids.join('|'),copyIds:ids});
    view.faces=view.faces.filter(f=>!holeFaces.includes(f));
    return {snapshot,label:'缺面演示：原凸包内部仍须扣除真实孔洞'};
  }
  if(kind==='sphere'||kind==='tetrahedron')return {snapshot:sphereSeamTriangleFixture(kind),label:'近似截图：内部 16 面着色，外部 48 面留空，粘边两侧同步'};
  if(kind==='open-v'){
    const engine=new GameEngine({boardDefinition:createSurfacePreset('sphere',{gridSize:7})});
    for(const point of ['cv:2','cv:14','cv:5']){const r=engine.playMove(point);if(!r.success)throw Error(point+' 不合法');}
    return {snapshot:engine.getSnapshot(),label:'真实三步：开放 V 的面保持填色'};
  }
  if(kind.startsWith('cylinder')){
    const definition=createSurfacePreset('cylinder',{width:8,height:8});
    definition.startingVertices={BLACK:'v:3,2',WHITE:'v:4,8'};
    definition.topology.movementStrategy=kind==='cylinder-old'?'simple-rays-v2':'simple-rays-v3';
    const engine=new GameEngine({boardDefinition:definition}),result=engine.playMove([1,5]);
    return {snapshot:engine.getSnapshot(),label:kind==='cylinder-old'?'历史 v2：错误转向导致绕行线；仅用于重放旧局':'新局 v3：拒绝依赖跨缝折弯的落子，无额外绕圈',result:result.success};
  }
  const shape=kind==='hexagon'?'hexagon':'triangle',startPlayer=kind==='triangle-white'?'WHITE':'BLACK';
  const engine=new GameEngine({gridSize:9,playerCount:2,boardShape:shape,startPlayer,rulesVersion:'territory-v3',protectionRule:'duel-first-unprotected-v1'});
  return {snapshot:engine.getSnapshot(),label:shape==='hexagon'?'六边形双方禁区保留':`${startPlayer==='BLACK'?'蓝方':'红方'}为实际先手：仅先手起点没有禁区`};
}
function show(kind){try{
  surface?.destroy();surface=null;
  const {snapshot,label,result}=prepare(kind);
  renderer.invalidate();renderer.render(snapshot);
  if(snapshot.isTopologyBoard)surface=mountTopologySurface3D(document.querySelector('#surface'),snapshot,{language:'zh'});
  const pieces=snapshot.isTopologyBoard?buildTopologyTerritoryDisplay(snapshot):[];
  const check=kind==='notch'?`；下部有效区域 ${inside(pieces,[4,5])?'有色':'缺色'}，盘外凹口 ${inside(pieces,[4,6.8])?'错误填色':'留空'}`:result===undefined?'':`；落子${result?'被接受':'被拒绝'}`;
  document.querySelector('#status').textContent=label+check;
  for(const button of document.querySelectorAll('[data-fixture]'))button.setAttribute('aria-pressed',String(button.dataset.fixture===kind));
}catch(error){document.querySelector('#status').textContent='失败：'+error.message;console.error(error);}}
for(const button of document.querySelectorAll('[data-fixture]'))button.addEventListener('click',()=>show(button.dataset.fixture));
show('notch');
