import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const origin=process.argv[2];assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const root=path.dirname(fileURLToPath(import.meta.url));
const frontend=path.join(root,'repo/web/web前端');
const miniRepo=path.resolve(root,'../release-all-20261024-mini-cnypk0q6/repo');
const worker=path.join(miniRepo,'wechat/minigame/dist/workers/index.js');
const sha=x=>createHash('sha256').update(x).digest('hex');
const before=sha(await fs.readFile(worker));
const candidateWorker=path.join(miniRepo,'local_artifacts/wechat-candidates/0.12.7-209d74994947-ga5bqS/project/dist/workers/index.js');
assert.equal(before,sha(await fs.readFile(candidateWorker)));
globalThis.location=new URL(origin);
const {default:Network}=await import(pathToFileURL(path.join(frontend,'CrossPlatformNetwork.js')));
const {device}=await import(pathToFileURL(path.join(miniRepo,'wechat/minigame/tests/transport-device.mjs')));
const {until}=await import(pathToFileURL(path.join(miniRepo,'wechat/minigame/tests/helpers.mjs')));
const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
const network=new Network({storage,requestPasswordSession:({login})=>login({username:'web-friend',password:'test-only-password'})});
network.url=origin.replace('http:','ws:')+'/ws';network.setAuthToken('synthetic-legacy-session');
const mini=device(origin,'red');const checks=[];
try{
 await network.createSharedRoom({playerCount:2,gridSize:7,boardShape:'triangle',startPlayer:'BLACK',
  rulesVersion:'territory-v3',undoEnabled:true,undoMaxCount:3,turnTimerEnabled:false});
 assert.equal(network.shared.room.settings.rulesVersion,'territory-v3');
 assert.equal(network.shared.room.scores.BLACK,1);checks.push('web-create-v3-owned-point-score');
 assert.equal(await mini.client.enter('join',network.roomId),true,mini.client.error);
 await until(()=>network.shared.room.members.WHITE&&mini.client.connected);
 assert.equal(mini.client.room.settings.rulesVersion,'territory-v3');
 assert.equal(mini.client.room.stateHash,network.shared.room.stateHash);checks.push('compiled-mini-worker-joins-and-hashes-v3');
 await network.updateRoomSettings({...network.shared.room.settings,startPlayer:'WHITE'});
 await until(()=>mini.client.room.settings.startPlayer==='WHITE');
 assert.equal(mini.client.room.currentPlayer,'WHITE');
 await network.updateStartPlayer('BLACK');await until(()=>mini.client.room.currentPlayer==='BLACK');
 checks.push('web-host-settings-and-starter-broadcast-to-mini');
 await network.sendReady(true);assert.equal(await mini.client.command('ready'),true,mini.client.error);
 await until(()=>network.canAct());
 await network.sendMove([1,0]);await until(()=>mini.client.room.seq===1&&mini.client.canPlay());
 const move=mini.client.game.snapshot.legalMoves.find(m=>Array.isArray(m.point))?.point;
 assert(move);assert.equal(await mini.client.act({type:'move',point:move}),true,mini.client.error);
 await until(()=>network.shared.room.seq===2);
 assert.equal(network.shared.room.stateHash,mini.client.room.stateHash);checks.push('both-ends-move-and-share-authoritative-hash');
 await network.sendUndo(true);await until(()=>mini.client.room.undo?.pending===true);
 assert.equal(network.canAct(),false);assert.equal(mini.client.canPlay(),false);
 assert.equal(await mini.client.voteUndo(true),true,mini.client.error);
 await until(()=>network.shared.room.seq===1&&mini.client.room.seq===1);
 assert.equal(network.shared.room.undo.usedCount,1);
 assert.equal(network.shared.room.stateHash,mini.client.room.stateHash);checks.push('cross-platform-two-party-undo-with-action-lock-and-replay');
 const hash=network.shared.room.stateHash;
 network.shared.closeSocket();await network.joinRoom(network.roomId,network.playerId);
 assert.equal(network.shared.room.stateHash,hash);assert.equal(network.shared.connected,true);
 checks.push('web-socket-resume-retains-v3-position');
 assert.equal(before,sha(await fs.readFile(worker)));
 const receipt={status:'PASS_REAL_LOOPBACK_HTTP_WS_COMPILED_MINI_WORKER',checks,compiledWorkerSha256:before,
   sharedServiceRulesVersion:network.shared.room.settings.rulesVersion,webGameEngineSha256:sha(await fs.readFile(path.join(frontend,'GameEngine.js'))),
   scope:'Synthetic login only; frozen shared-service API+Node verifier, real HTTP/WebSocket, Web client and actual Mini compiled Worker',
   limits:['No production account, phone, production-domain transport or public release verification.']};
 await fs.writeFile(path.join(root,'real-crossplatform-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(receipt));
}finally{try{await network.leaveRoom({bestEffort:true});}catch{}network.disconnect();mini.stop();}
