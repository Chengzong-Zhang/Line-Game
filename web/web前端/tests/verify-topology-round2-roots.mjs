import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import "../TopologyGameEngine.js";
import { GameEngine, PLAYER_ORDER } from "../GameEngine.js";
import { createSurfacePreset } from "../BoardPresets.js";
import { compileBoard } from "../BoardCompiler.js";
import { createTopologyStartingDefinition } from "../TopologyStartingPoints.js";
import { GameController } from "../GameController.js";
import { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } from "../AIStateProtocol.js";
import { createTopologyReplayDocument, validateTopologyReplayDocument } from "../ReplayCodec.js";

const compile = definition => {const r=compileBoard(definition); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value;};
const layout = (size, playerCount=2, countPerPlayer=2) => createTopologyStartingDefinition(
  compile(createSurfacePreset("cylinder", {gridSize:size})), {playerCount, countPerPlayer, mode:"default"});

for (const size of [5,15]) for (let count=2; count<=6; count++) {
  const definition = layout(size,count), board=compile(definition), game=new GameEngine({boardDefinition:definition,playerCount:count});
  assert.deepEqual(game.activePlayers, PLAYER_ORDER.slice(0,count));
  assert.deepEqual(game.initialRoots, board.startingRoots);
  const seen = new Set();
  for (const [i,player] of game.activePlayers.entries()) {
    assert.equal(game.initialRoots[player].length,2);
    assert.equal(game.initialPositions[player], game.initialRoots[player][0]);
    for (const root of game.initialRoots[player]) {
      assert.ok(!seen.has(root)); seen.add(root);
      assert.equal(game.grid.get(root), 1 + 2*i, `${size} ${player} root node state`);
      for (const other of game.activePlayers.filter(p=>p!==player)) for (const neighbor of game.getAdjacentPositions(root)) {
        assert.equal(game._isInProtectionZone(neighbor,other),true, `${player} root protects every neighbor against ${other}`);
      }
    }
  }
  assert.deepEqual(game.getSnapshot().topology.startingRoots,game.initialRoots);
}
const legacyDefinition = createSurfacePreset("cylinder",{gridSize:5});
legacyDefinition.topology.movementStrategy = "simple-rays-v1";
const original = compile(legacyDefinition);
// Independent baseline: the same scalar-start definition canonicalized with
// BoardDefinition.js from commit a1dc6d75aaa2a3afceedb60daf4aacdf70c5f8d4.
assert.equal(original.boardHash,"0815891101d47920771fd430af4e6b2121cf832bcf5b021cdda8c427879acfa6", "legacy scalar-start canonical hash");
const oneRoot = compile(createTopologyStartingDefinition(original,{mode:"default",playerCount:2,countPerPlayer:1}));
assert.equal(oneRoot.boardHash,original.boardHash,"old scalar definition hash is preserved by default one-root selection");
assert.ok(Object.values(oneRoot.definition.startingVertices).every(v=>typeof v === "string"));
const duplicate=structuredClone(original.definition);
duplicate.startingVertices.BLACK=["v:0,0","v:4,0"];
assert.equal(compileBoard(duplicate).ok,false,"distinct raw copies of the same seam root are rejected");
const repeated=structuredClone(original.definition);
repeated.startingVertices.BLACK=["v:1,1","v:1,1"];
assert.equal(compileBoard(repeated).ok,false,"duplicate roots are rejected");
const cross=structuredClone(original.definition);
cross.startingVertices.WHITE=cross.startingVertices.BLACK;
assert.equal(compileBoard(cross).ok,false,"two players cannot share a root");

const definition=structuredClone(layout(9));
// This fixed cut witness was found under the historical v2 seam transport.
definition.topology.movementStrategy = "simple-rays-v2";
const game=new GameEngine({boardDefinition:definition});
const [firstRoot,secondRoot]=game.initialRoots.BLACK;
const move=game.getLegalMoves().find(({vertexId})=>{
  const paths=game._connectionsForPlacement(vertexId,"BLACK",game.grid.get(vertexId));
  return paths.length===1 && paths[0].endVertexId===secondRoot && paths[0].vertices.length>=3;
});
assert.ok(move,"fixture finds a legal extension connected only to the second root");
const selectedPath=game._connectionsForPlacement(move.vertexId,"BLACK",game.grid.get(move.vertexId))[0];
assert.equal(game.playMove(move.vertexId).success,true);
assert.equal(game.grid.get(move.vertexId),1,"a structure attached to second root survives rebuild");
assert.ok([...game.topologyPaths.BLACK.values()].some(p=>p.endVertexId===secondRoot));
const encoded=game.encodeTopologyState();
const saved=game._captureTopologyState();
const restored=new GameEngine({boardDefinition:definition});
assert.equal(restored.restoreTopologyState(encoded),true);
assert.deepEqual(restored.getTopologyRuleState(),game.getTopologyRuleState(),"restore retains all roots, paths, turn and history");
const corrupted=structuredClone(encoded);
delete corrupted.ruleState.vertexStateById[secondRoot];
assert.throws(()=>restored.restoreTopologyState(corrupted),/MISSING_START_NODE/);
assert.deepEqual(restored.getTopologyRuleState(),game.getTopologyRuleState(),"failed restore leaves complete state unchanged");

const controller=Object.create(GameController.prototype);
const defaultRuleController=controller._createEngine({boardDefinition:definition,playerCount:2});
assert.equal(defaultRuleController.rulesVersion,"surface-v1","topology definitions default to the topology rule");
assert.deepEqual(defaultRuleController.initialRoots,game.initialRoots);
const fromController=controller._createEngine({boardDefinition:definition,playerCount:2,rulesVersion:"surface-v1",initialPositions:{BLACK:firstRoot,WHITE:game.initialPositions.WHITE}});
assert.deepEqual(fromController.initialRoots,game.initialRoots,"legacy first-root settings cannot truncate definition");
assert.equal(fromController.boardHash,game.boardHash);
const replay=await createTopologyReplayDocument({boardDefinition:definition},[{type:"move",vertexId:move.vertexId},{type:"skip"},{type:"skip"}]);
const checkedReplay=await validateTopologyReplayDocument(replay);
assert.equal(checkedReplay.success,true,checkedReplay.reason);
assert.equal(checkedReplay.actions.length,3);
const batch=game.replayBatch(transaction=>transaction.skipTurn());
assert.equal(batch.success,true);
assert.deepEqual(game.initialRoots,restored.initialRoots,"transaction replay keeps multiple roots");
game._restoreTopologyState(saved);

// Build a second endpoint branching exclusively from the first extension,
// then perform a real opponent cut: both rootless endpoints must disappear.
const cutGame=new GameEngine({boardDefinition:definition});
cutGame.restoreTopologyState(encoded);
assert.equal(cutGame.skipTurn().success,true);
const beforeBranch=cutGame._captureTopologyState();
let branch=null, cut=null;
for(const candidate of cutGame.getLegalMoves()) {
  cutGame._restoreTopologyState(beforeBranch);
  const paths=cutGame._connectionsForPlacement(candidate.vertexId,"BLACK",cutGame.grid.get(candidate.vertexId));
  if(!paths.length || paths.some(path=>path.endVertexId!==move.vertexId)) continue;
  if(!cutGame.playMove(candidate.vertexId).success) continue;
  const possibleCut=cutGame.getLegalMoves().find(item=>selectedPath.vertices.slice(1,-1).includes(item.vertexId));
  if(!possibleCut) continue;
  branch=candidate; cut=possibleCut; break;
}
assert.ok(branch && cut,"fixture finds a rootless branch and a real legal cut");
assert.equal(cutGame.playMove(cut.vertexId).success,true);
assert.equal(cutGame.grid.get(move.vertexId),0,"severed rootless structure is removed");
assert.equal(cutGame.grid.get(branch.vertexId),0,"the whole disconnected branch is removed");
assert.equal(cutGame.grid.get(firstRoot),1);
assert.equal(cutGame.grid.get(secondRoot),1);
assert.equal(cutGame.topologyPaths.BLACK.size,0);

const workerAdapter=`const {parentPort,workerData}=require('node:worker_threads');
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
import(workerData).then(()=>parentPort.on('message',data=>self.onmessage({data}))).catch(error=>{throw error;});`;
const worker=new Worker(workerAdapter,{eval:true,workerData:new URL('../AIWorker.js',import.meta.url).href});
try {
  const request=captureWorkerRequest(game,"multi-root-worker"), serial=serializeEngineState(game);
  assert.deepEqual(serial.topologyState.ruleState.startingVertices, game.getTopologyRuleState().startingVertices);
  const invoke=(payload)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("multi-root worker timeout")),15000);
    worker.once("message",v=>{clearTimeout(timer);resolve(v);});
    worker.once("error",e=>{clearTimeout(timer);reject(e);});
    worker.postMessage(payload);
  });
  const payload={type:"COMPUTE",requestId:"multi-root-worker",strategy:"topology-generic",serializedState:serial,aiPlayer:game.currentPlayer,depth:1,topN:1,timeLimitMs:3000};
  const result=await invoke(payload);
  assert.equal(result.type,"RESULT",result.message);
  assert.equal(isWorkerResultForRequest(game,request,result),true);
  assert.ok(result.moves.length);
  if(result.moves[0].type==="move") assert.equal(game._evaluateMove(result.moves[0].vertexId).legal,true);
  else assert.equal(result.moves[0].type,"pass");
  const badSerial=structuredClone(serial);
  delete badSerial.topologyState.ruleState.vertexStateById[secondRoot];
  const rejection=await invoke({...payload,requestId:"missing-root",serializedState:badSerial});
  assert.equal(rejection.type,"ERROR","real Worker rejects a missing root in the encoded position");
  assert.match(rejection.message,/MISSING_START_NODE/);
  assert.deepEqual(game._captureTopologyState(),saved,"actual worker cannot mutate active state");
} finally {await worker.terminate();}
console.log("topology round2 roots: PASS (2–6 players, sizes 5/15, root protection, cut, state, replay, controller and actual worker)");
