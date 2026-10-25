import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, plain } from './helpers.mjs';
// helpers imports one bundled data URL; do not print megabytes of source in an
// expected rules failure or a failed assertion's stack.
Error.stackTraceLimit = 0;

const message = (kind, settings, actions, extra = {}) => ({ kind, payload: { settings, actions, ...extra }, context: {} });
const fresh = input => sut.createTaskRuntime()(input);
async function equal(runtime, input) {
  const expected = await fresh(plain(input)), actual = await runtime(input);
  assert.deepEqual(actual, expected); return actual;
}
function actionsFor(settings, steps) {
  const engine = sut.restoreGame(settings), actions = [];
  for (let turn = 0; turn < steps && !engine.gameOver; turn++) {
    const legal = engine.getLegalMoves(), player = engine.currentPlayer;
    const action = legal.length ? { type: 'move', player, point: legal[(turn * 7 + 3) % legal.length].point } : { type: 'skip', player };
    assert.equal(sut.applyAction(engine, action).success, true); actions.push(action);
  }
  return actions;
}

test('full history prefix reuse eliminates replayed moves and returns isolated snapshots', async () => {
  const settings = sut.settingsFor(5, 3), actions = actionsFor(settings, 8), run = sut.createTaskRuntime();
  const original = sut.GameEngine.prototype.playMove;
  let played = 0;
  sut.GameEngine.prototype.playMove = function (...args) { played++; return original.apply(this, args); };
  try {
    const first = await run(message('STATE', settings, actions.slice(0, 6))); assert.equal(played, 6);
    const applied = await run(message('APPLY', settings, actions.slice(0, 6), { action: actions[6] })); assert.equal(played, 7);
    const repeated = await run(message('STATE', settings, actions.slice(0, 7))); assert.equal(played, 7);
    assert.deepEqual(repeated, applied);
    first.snapshot.boardMatrix[0][0] = 99;
    first.ruleState.historyHashes.push('foreign');
    applied.snapshot.initialPositions.BLACK[0] = 99;
    applied.snapshot.territories.BLACK.polygon?.push([99,99]);
    applied.snapshot.legalMoves[0]?.point.fill(99);
    applied.ruleState.historyHashes.push('foreign');
    assert.deepEqual(await run(message('STATE', settings, actions.slice(0, 7))), repeated);
    assert.equal(played, 7);
    await run(message('STATE', settings, actions)); assert.equal(played, actions.filter(action => action.type === 'move').length);
  } finally { sut.GameEngine.prototype.playMove = original; }
});

test('settings, original array mutations, undo, branching, pass and resignation retain exact rule state', async () => {
  const run = sut.createTaskRuntime();
  for (const count of [2, 3, 4, 5, 6]) {
    const settings = sut.settingsFor(5, count), actions = actionsFor(settings, 8);
    for (let length = 0; length <= actions.length; length++) await equal(run, message('STATE', settings, actions.slice(0,length)));
    const sameArray = plain(actions.slice(0,4));
    await equal(run, message('STATE', settings, sameArray));
    // A valid different first move, with the same array identity and length.
    const opening = sut.restoreGame(settings).getLegalMoves()[0].point;
    sameArray.splice(0, sameArray.length, { type:'move', player:'BLACK', point:opening });
    await equal(run, message('STATE', settings, sameArray));
    sameArray[0] = { type:'skip', player:'BLACK' };
    await equal(run, message('STATE', settings, sameArray));
    const starts = sut.restoreGame(settings).getLegalMoves();
    sameArray[0] = { type:'move', player:'BLACK', point:[...starts[0].point] };
    await equal(run, message('STATE', settings, sameArray));
    if (starts[1]) {
      sameArray[0].point[0] = starts[1].point[0]; sameArray[0].point[1] = starts[1].point[1];
      await equal(run, message('STATE', settings, sameArray));
    }
    const after = await equal(run, message('STATE', settings, actions.slice(0,3)));
    const branch = [...actions.slice(0,3), { type:'skip', player:after.snapshot.currentPlayer }];
    await equal(run, message('STATE', settings, branch));
    await equal(run, message('STATE', settings, actions.slice(0,3)));
    const resigned = [{ type:'resign', player:'BLACK' }];
    await equal(run, message('STATE', settings, resigned));
    await equal(run, message('STATE', settings, Array.from({length:count},()=>({type:'skip'}))));
    settings.startPlayer = count > 2 ? 'PURPLE' : 'WHITE';
    await equal(run, message('STATE', settings, []));
    settings.gridSize = 7; await equal(run, message('STATE', settings, []));
  }
});

test('AI, hint and analysis reuse only unchanged state and errors cannot poison later turns', async () => {
  const run = sut.createTaskRuntime();
  for (const [count, profile] of [[2,'minimax-2'],[3,'three-player-policy-v1'],[6,'hex-player-policy-v1']]) {
    const settings=sut.settingsFor(5,count), actions=actionsFor(settings,3);
    const position=await equal(run,message('STATE',settings,actions));
    for(const kind of ['AI','HINT','ANALYZE']) {
      await equal(run,message(kind,settings,actions,{profile}));
      await equal(run,message('STATE',settings,actions));
    }
    await assert.rejects(async()=>run(message('AI',settings,actions,{profile:'not-a-profile'})),/INVALID_CONTROLLERS/);
    await equal(run,message('STATE',settings,actions));
    const action={type:'move',player:position.snapshot.currentPlayer,point:position.snapshot.legalMoves[0].point};
    await equal(run,message('APPLY',settings,actions,{action}));
    await equal(run,message('STATE',settings,[...actions,action]));
  }
  const settings=sut.settingsFor(5), actions=actionsFor(settings,4);
  const method=sut.MinimaxAI.prototype.getTopMoves;
  try {
    for(const throws of [false,true]) {
      sut.MinimaxAI.prototype.getTopMoves=function(engine){engine.historyHashes.add('poison'); if(throws)throw Error('INJECTED_FAILURE'); return [];};
      await assert.rejects(async()=>run(message('AI',settings,actions,{profile:'minimax-2'})),/SEARCH_MUTATED_STATE|INJECTED_FAILURE/);
      await equal(run,message('STATE',settings,actions));
    }
  } finally { sut.MinimaxAI.prototype.getTopMoves=method; }
});

test('invalid suffix and altered same-length prefix fall back without retaining partially applied input', async()=>{
  const run=sut.createTaskRuntime(), settings=sut.settingsFor(5,3), actions=actionsFor(settings,5);
  await equal(run,message('STATE',settings,actions));
  for(const bad of [[...actions,{type:'move',point:[99,99]}], [...actions.slice(0,2),{type:'invalid'},...actions.slice(3)]]) {
    await assert.rejects(async()=>run(message('STATE',settings,bad)),/INVALID_POINT|INVALID_ACTION/);
    await equal(run,message('STATE',settings,actions));
  }
  const sparse=Array(2); await assert.rejects(async()=>run(message('STATE',settings,sparse)),/INVALID_ACTION/);
  await equal(run,message('STATE',settings,actions));
  const custom={...settings};Object.defineProperty(custom,'gridSize',{value:7,enumerable:false});
  assert.deepEqual(await run(message('STATE',custom,[])),await fresh(message('STATE',custom,[])));
  await equal(run,message('STATE',settings,[]));
});

test('asynchronous completions cannot replace newer cached settings; replay and import are isolated', async()=>{
  const run=sut.createTaskRuntime(), settings=sut.settingsFor(5,6), actions=actionsFor(settings,3);
  await equal(run,message('STATE',settings,actions));
  const ai=run(message('AI',settings,actions,{profile:'hex-player-policy-v1'}));
  const other=sut.settingsFor(5,3);await equal(run,message('STATE',other,[]));
  assert.deepEqual(await ai,await fresh(message('AI',settings,actions,{profile:'hex-player-policy-v1'})));
  await equal(run,message('STATE',other,[]));
  const doc=await sut.createReplayDocument(other,[{type:'move',point:[1,0]}],sut.checksum);
  await equal(run,{kind:'IMPORT_REPLAY',payload:{text:JSON.stringify(doc)}});
  await equal(run,message('STATE',settings,actions));
  await equal(run,message('REPLAY_STEP',settings,actions,{cursor:2}));
  await equal(run,message('STATE',settings,actions));
});
