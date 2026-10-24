import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import GameEngine from '../GameEngine.js?v=20261024-all1';
import { canonicalize, serializeRuleState } from '../ReplayCodec.js?v=20261024-all1';
import { SharedRoomClient, verifySharedRoom, sharedRoomPayload } from '../SharedRoomClient.js?v=20261024-all1';
import { TrainingContribution } from '../TrainingContribution.js?v=20261024-all1';

const storage = { getItem: () => null, setItem() {}, removeItem() {} };
function room(rulesVersion, revision=1, actions=[]) {
  const settings={playerCount:2,gridSize:7,boardShape:'triangle',rulesVersion,startPlayer:'BLACK',undoEnabled:true,undoMaxCount:3};
  const engine=new GameEngine(settings);
  for(const action of actions) assert.equal(engine.playMove(action.point).success,true);
  const state=engine.getSnapshot();
  return { protocol:1,code:'ABCDEFGH',matchId:'a'.repeat(32),revision,seq:actions.length,actions,
    actionIds:actions.map((_,i)=>`fixture-action-${i}`),player:'BLACK',currentPlayer:state.currentPlayer,status:'playing',
    settings,ready:{BLACK:true,WHITE:true},members:{BLACK:true,WHITE:true},rematchVotes:{BLACK:false,WHITE:false},
    scores:{BLACK:state.territories.BLACK.area,WHITE:state.territories.WHITE.area},gameOver:state.gameOver,winner:state.winner,
    stateHash:'sha256:'+createHash('sha256').update(canonicalize(serializeRuleState(engine))).digest('hex'),
    undo:{usedCount:0,pending:false,votes:[]} };
}
const v2=room('territory-v2'),v3=room('territory-v3');
assert.equal((await verifySharedRoom(v2)).getSnapshot().territories.BLACK.area,0);
assert.equal((await verifySharedRoom(v3)).getSnapshot().territories.BLACK.area,1);
await assert.rejects(verifySharedRoom({...v3,settings:{...v3.settings,rulesVersion:'territory-v4'}}));
const client=new SharedRoomClient({storage});
client.connect=async()=>{};
const requests=[];
client.request=async(path,data)=>{requests.push({path,data});return v3;};
await client.enter('create',{gridSize:7,undoEnabled:true});
assert.deepEqual(requests[0],{path:'rooms',data:{gridSize:7,undoEnabled:true,rulesVersion:'territory-v3'}});
await client.updateSettings({...v3.settings,startPlayer:'WHITE'});
assert.equal(requests.at(-1).data.settings.startPlayer,'WHITE');
await client.undo(true);
assert.deepEqual(requests.at(-1).data,{expectedSeq:0,beforeHash:v3.stateHash,accept:true,matchId:v3.matchId});
const pending={...v3,revision:2,undo:{usedCount:0,pending:true,votes:['BLACK']}};
await client.receive(pending);client.connected=true;
assert.equal(client.canAct(),false,'pending agreement must lock actions');
assert.deepEqual(sharedRoomPayload(pending).undo.votes,['ABCDEFGH:BLACK']);
await client.receive({...v2,revision:1});
assert.equal(client.room.settings.rulesVersion,'territory-v3','older revision cannot replace newer rule state');
const contribution=new TrainingContribution({storage,fetcher:async()=>{throw Error('must not upload v3');}});
assert.equal(await contribution.enqueue(v3.settings,[],{}),false);
await contribution.flush();assert.equal(contribution.queue.length,0);
console.log('verify-shared-release-v3: PASS (legacy v2 and new v3 replay; versioned create, settings and undo body; votes, pending action lock, stale revision and v3 contribution isolation)');
