import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createReplayDocument, validateReplayDocument } from '../../web/web前端/ReplayCodec.js';
import TerritoryWorkerPool from '../../web/web前端/TerritoryWorkerPool.js';
import * as VueRuntime from 'vue';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'mobile/dist');
const receiptPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const version = '20261013-full-features1';
const key = 'lifeline-local-game-session-v1';
const clearKey = 'lifeline-local-game-session-cleared-v1';
const topologyKey = 'lifeline-topology-local-game-session-v1';
const sourceNames = ['mobile-entry.js','platform/mobile-bridge.js','platform/harmony-bridge.js','platform/harmony-native-bridge.js','platform/platform-selection.js','platform/session-authority.js','platform/session-envelope.js','platform/session-mirror.js','OnlineApp.js','LocalGameSession.js','GameController.js','GameEngine.js','NetworkManager.js','CrossPlatformNetwork.js','SharedRoomClient.js','OnlineActionSync.js','OnlineActionSyncCoordinator.js','OnlineRoomSync.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name,hash(await readFile(path.join(dist,name)))])));
const before = await hashes();
const session = actions => JSON.stringify({format:'lifeline-local-session',schemaVersion:1,savedAt:1,settings:{playerCount:2,gridSize:9,startPlayer:'BLACK',rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,hintEnabled:true,hintMaxCount:3},actions,playContext:{aiMode:'none',aiDepth:3,aiStrategy:'minimax',aiModelVersion:'2026092201',aiSeed:null,aiDuelPaused:false,tutorialDismissed:true}});
const empty = session([]);
const moved = session([{type:'player_move',point:[1,0]}]);
const setLocalMatch = (payload, {black = 'human', white = 'human', paused = false} = {}) => {
  payload.match = {players: {
    BLACK: {choice:black,depth:3,version:'2026092201'},
    WHITE: {choice:white,depth:3,version:'2026092201'},
  }, started:true, paused};
  return payload;
};
const envelope = (revision,payload) => JSON.stringify({format:'lifeline-local-session-envelope',version:1,revision,state:payload===null?'cleared':'saved',...(payload===null?{}:{payload})});
const flushMicrotasks=async()=>{for(let index=0;index<8;index+=1)await Promise.resolve();};

async function openPage(platform,{local=null,native=null,auth=null,legacyCleared=false,realVue=false,controlledWorkers=false,currentOnlineApp=false,appInfoProvider=()=>({version:'1.0',build:'1'})}={}) {
  const localValues = new Map(local===null?[]:[[key,local]]);
  if (legacyCleared) localValues.set(clearKey,'1');
  if (auth) localValues.set('triaxis-auth',JSON.stringify(auth));
  let nativeValue = native;
  let topologyNativeValue = null;
  let nativeCredentialState = 'missing';
  let nativeCredential = null;
  let credentialOwnerGeneration = 0;
  const nativeDocumentNonce = 'synthetic-native-document-nonce';
  let failLocal = false;
  let failNative = false;
  let pausedNative = null;
  let appStateListener = null;
  const calls = [];
  const events = new EventTarget();
  const unmounts=[];
  const workers=[];
  const webSockets=[];
  const timers=new Map();
  let timerSequence=0;
  const noop=()=>{};
  class TestWebSocket extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
    constructor(url){super();this.url=url;this.readyState=TestWebSocket.CONNECTING;this.sent=[];this.closeCalls=[];webSockets.push(this);}
    send(text){this.sent.push(JSON.parse(text));}
    close(code=1000,reason='client_disconnect'){this.closeCalls.push({code,reason});this.readyState=TestWebSocket.CLOSED;this.dispatchEvent(Object.assign(new Event('close'),{code,reason,wasClean:true}));}
    open(){this.readyState=TestWebSocket.OPEN;this.dispatchEvent(new Event('open'));}
    message(payload){this.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify(payload)}));}
  }
  const schedule=(callback,delay,interval,args=[])=>{const id=++timerSequence;timers.set(id,{callback,delay,interval,args});return id;};
  const sandbox = {
    console,URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,Uint32Array,ArrayBuffer,Blob,Request,Response,Headers,AbortController,
    fetch:async()=>({ok:true,text:async()=>''}),
    CustomEvent,Event,EventTarget,WebSocket:TestWebSocket,crypto:webcrypto,
    setTimeout:controlledWorkers?(callback,delay=0,...args)=>schedule(callback,delay,false,args):setTimeout,
    clearTimeout:controlledWorkers?(id)=>timers.delete(id)||clearTimeout(id):clearTimeout,
    setInterval:controlledWorkers?(callback,delay=0,...args)=>schedule(callback,delay,true,args):setInterval,
    clearInterval:controlledWorkers?(id)=>timers.delete(id)||clearInterval(id):clearInterval,
    queueMicrotask,
    localStorage:{getItem:name=>localValues.get(name)??null,setItem(name,value){if(name===key&&failLocal){failLocal=false;throw new Error('Synthetic local write failure');}localValues.set(name,String(value));},removeItem:name=>localValues.delete(name)},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
    document:{hidden:false,visibilityState:'visible',documentElement:{dataset:{}},title:'',body:{classList:{toggle:noop,remove:noop}},addEventListener(){},removeEventListener(){}},
    location:new URL('http://synthetic-mobile-review.localhost/'),open:noop,__LIFELINE_MOBILE_APP__:false,
    Vue:realVue?VueRuntime:{ref:value=>({value}),shallowRef:value=>({value}),computed:read=>({get value(){return read();}}),watch:noop,nextTick:async()=>{},onMounted:noop,onBeforeUnmount:callback=>unmounts.push(callback)},
  };
  if(controlledWorkers)sandbox.Worker=class ControlledWorker{constructor(url,options){this.url=String(url);this.options=options;this.messages=[];this.terminated=false;workers.push(this);}postMessage(message){this.messages.push(message);}terminate(){this.terminated=true;}emit(data,type='message'){const event={data,preventDefault(){}};if(type==='error')this.onerror?.(event);else this.onmessage?.(event);}};
  async function nativeOperation(operation,passedKey,value,args={}){
    if(operation==='getAppInfo'){
      assert.equal(passedKey,'');
      calls.push({operation,value});
      return await appInfoProvider();
    }
    if (['claimCredentialOwner','loadCredential','saveCredential','clearCredential'].includes(operation)) {
      const request = platform === 'android' ? args : (value ? JSON.parse(value) : {});
      calls.push({operation,request});
      if (operation === 'claimCredentialOwner') {
        assert.equal(request.documentChallenge, context.__LIFELINE_DOCUMENT_CHALLENGE__, 'native claim is bound to the current document challenge');
        assert.equal(typeof request.expectedOwnerGeneration, 'number');
        if (request.expectedOwnerGeneration !== -1) assert.equal(request.expectedOwnerGeneration, credentialOwnerGeneration);
        credentialOwnerGeneration += 1;
        return {pageEpoch:7,ownerGeneration:credentialOwnerGeneration,documentNonce:nativeDocumentNonce};
      }
      assert.equal(request.pageEpoch,7,'credential request carries the native-issued document epoch');
      assert.equal(request.ownerGeneration,credentialOwnerGeneration,'credential request carries the current owner lease');
      assert.equal(request.documentNonce,nativeDocumentNonce,'credential request carries the native-issued document nonce');
      if (operation === 'loadCredential') return nativeCredentialState === 'present'
        ? {state:'present',credential:structuredClone(nativeCredential)} : {state:nativeCredentialState};
      if (operation === 'saveCredential') {
        assert.deepEqual(Object.keys(request.credential).sort(),['token','username']);
        nativeCredential = structuredClone(request.credential); nativeCredentialState = 'present';
        return {durable:true};
      }
      nativeCredential = null; nativeCredentialState = 'cleared';
      return {durable:true};
    }
    if (passedKey === topologyKey) {
      if (operation === 'loadRecord') return { value: topologyNativeValue };
      if (operation === 'saveRecord') { topologyNativeValue = value; return platform === 'android' ? { durable: true } : { flushed: true }; }
      throw new Error(`Unexpected topology operation ${operation}`);
    }
    assert.equal(passedKey,key);
    calls.push({operation,value});
    if(operation==='loadRecord')return {value:nativeValue};
    if(operation==='saveRecord'){
      if(pausedNative){const paused=pausedNative;pausedNative=null;paused.started();await paused.hold;}
      if(failNative){failNative=false;throw new Error('Synthetic native write failure');}
      nativeValue=value; return platform==='android'?{durable:true}:{flushed:true};
    }
    throw new Error(`Unexpected native operation ${operation}; clears must retain a revisioned record`);
  }
  if(platform==='harmony') sandbox.LifelineArkTS={callNative(requestId,operation,passedKey,value){
    void nativeOperation(operation,passedKey,value).then(result=>sandbox.__lifelineNativeComplete(requestId,JSON.stringify({ok:true,result})),error=>sandbox.__lifelineNativeComplete(requestId,JSON.stringify({ok:false,error:String(error)})));
  }};
  else {
    sandbox.CapacitorCustomPlatform={name:'android'};
    sandbox.Capacitor={Plugins:{},PluginHeaders:[
      {name:'LifelineStorage',methods:[{name:'loadRecord',rtype:'promise'},{name:'saveRecord',rtype:'promise'},{name:'removeRecord',rtype:'promise'},{name:'claimCredentialOwner',rtype:'promise'},{name:'loadCredential',rtype:'promise'},{name:'saveCredential',rtype:'promise'},{name:'clearCredential',rtype:'promise'}]},
      {name:'App',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'},{name:'getState',rtype:'promise'},{name:'getInfo',rtype:'promise'}]},
    ],nativePromise(plugin,method,args){if(plugin==='LifelineStorage')return nativeOperation(method,args.key,args.value,args);if(plugin==='App'&&method==='getState')return Promise.resolve({isActive:true});if(plugin==='App'&&method==='getInfo')return nativeOperation('getAppInfo','', '');throw new Error(`Unexpected plugin ${plugin}`);},nativeCallback(plugin,method,_args,callback){if(plugin==='App'&&method==='addListener')appStateListener=callback;return Promise.resolve({callbackId:'synthetic-lifecycle'});}};
  }
  const context=vm.createContext(sandbox);
  const modules=new Map();
  const uri=name=>pathToFileURL(path.join(dist,name)).href;
  async function load(url){
    // Keep the full URL including its query: distinct browser module URLs must not be silently merged by this test.
    if(!modules.has(url)){
      const filename=fileURLToPath(url);
      const isMain=filename===path.join(dist,'main.js');
      const source=isMain?'globalThis.__parentBootstrapReached = true;':currentOnlineApp && filename===path.join(dist,'OnlineApp.js')
        ? await readFile(path.join(repo,'web/web前端/OnlineApp.js'),'utf8')
        : await readFile(filename,'utf8');
      modules.set(url,new vm.SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta,module){meta.url=module.identifier;},importModuleDynamically:async(specifier,referencing)=>evaluate(new URL(specifier,referencing.identifier).href)}));
    }
    return modules.get(url);
  }
  async function evaluate(url){const module=await load(url);if(module.status==='unlinked')await module.link((specifier,referencing)=>load(new URL(specifier,referencing.identifier).href));if(module.status==='linked')await module.evaluate();return module;}
  await evaluate(uri('mobile-entry.js'));
  assert.equal(context.__parentBootstrapReached,true,'generated entry reaches game bootstrap');
  const api=(await evaluate(uri('LocalGameSession.js')+'?v='+version)).namespace;
  return {
    context,api,calls,unmounts,workers,timers,webSockets,
    get local(){return localValues.get(key)??null;},get native(){return nativeValue;},get legacyClear(){return localValues.get(clearKey)??null;},
    failNextLocal(){failLocal=true;},failNextNative(){failNative=true;},
    pauseNextNative(){let started,release;const begun=new Promise(resolve=>{started=resolve;});const hold=new Promise(resolve=>{release=resolve;});pausedNative={started,hold};return {begun,release};},
    flush:()=>context.LifelinePlatform.flushSessionMirror(),
    dispatchLifecycle(name){context.dispatchEvent(new Event(`lifeline:${name}`));},
    emitNativeAppState(isActive){assert.equal(typeof appStateListener,'function','native appStateChange listener is registered');appStateListener({isActive});},
    save:payload=>api.persistLocalGameSession(JSON.parse(payload)),
    clear:()=>api.clearLocalGameSession(),
    load:()=>api.loadLocalGameSession(),
    async mountApp(mobileShell=true){
      context.__LIFELINE_MOBILE_APP__=mobileShell;
      const App=(await evaluate(uri('OnlineApp.js')+'?v='+version)).namespace.default;
      const GameEngine=(await evaluate(uri('GameEngine.js')+'?v='+version)).namespace.default;
      const GameController=(await evaluate(uri('GameController.js')+'?v='+version)).namespace.default;
      const settings=JSON.parse(empty).settings;
      let app;
      let vueApp=null;
      if(realVue){
        const host={type:'root',children:[]};
        const renderer=VueRuntime.createRenderer({
          createElement:type=>({type,children:[],props:{},parent:null}),createText:text=>({text:String(text),parent:null}),createComment:text=>({comment:String(text),parent:null}),
          setText(node,text){node.text=String(text);},setElementText(node,text){node.text=String(text);node.children=[];},patchProp(node,key,_old,value){node.props[key]=value;},
          insert(node,parent,anchor=null){node.parent=parent;const old=parent.children.indexOf(node);if(old>=0)parent.children.splice(old,1);const index=anchor?parent.children.indexOf(anchor):-1;if(index<0)parent.children.push(node);else parent.children.splice(index,0,node);},
          remove(node){if(node.parent){const index=node.parent.children.indexOf(node);if(index>=0)node.parent.children.splice(index,1);node.parent=null;}},parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
        });
        const wrapper={setup(){app=App.setup();return ()=>null;}};
        vueApp=renderer.createApp(wrapper);vueApp.mount(host);
      }else app=App.setup();
      const controller=Object.assign(Object.create(GameController.prototype),{
        canvas:{style:{},setAttribute:noop},options:{engine:{...settings}},engine:new GameEngine(settings),
        renderer:{invalidate:noop,render:noop,clearHintPoint:noop},_engineEpoch:0,
        _cancelTerritoryRefresh:noop,_scheduleTerritoryRefresh:noop,multiplayerEnabled:false,localPlayer:null,
        roomReady:false,opponentConnected:false,networkManager:null,lastAction:null,_networkUnsubscribers:[],
        _authoritativeSnapshotValid:true,stateChangeListener:app.handleStateChange,
      });
      // Current startup restores persisted games asynchronously before play.
      await Promise.resolve(app.handleControllerReady(controller));
      if (realVue) await VueRuntime.nextTick();
      return {app,controller,GameEngine,ReplayPanel:App.components.ReplayPanel,vueApp};
    },
    runTimers(maxDelay=Infinity){let count=0;while(true){const entry=[...timers.entries()].find(([,timer])=>timer.delay<=maxDelay);if(!entry)break;const [id,timer]=entry;if(!timer.interval)timers.delete(id);timer.callback(...timer.args);count+=1;if(count>1000)throw new Error('controlled timer loop exceeded 1000 callbacks');}return count;},
    fireTimer(id){const timer=timers.get(id);if(!timer)return false;timers.delete(id);timer.callback(...timer.args);return true;},
    cleanup(){for(const callback of unmounts)callback();},
    unmount(vueApp){vueApp?.unmount();},
  };
}

async function selectLegacyProtocolThroughWire(page, app, controller) {
  const connecting = app.handleConnect();
  const socket = page.webSockets.at(-1);
  assert.ok(socket, 'authenticated App connect creates its real NetworkManager WebSocket');
  socket.open();
  await flushMicrotasks();
  assert.ok(socket.sent.some(({type})=>type==='action_protocol_hello'), 'the actual coordinator starts action protocol negotiation');
  socket.message({type:'ERROR',code:'UNKNOWN_MESSAGE_TYPE',message:"Unsupported message type: 'action_protocol_hello'"});
  await connecting;
  assert.equal(controller._onlineActionSync.getState().protocol.status,'legacy',
    'legacy mode is enabled only after the real unsupported-message response is classified');
}

const roomSettings = { gridSize: 9, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v2', turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: true, hintMaxCount: 3 };
const connectedRoomPlayers = [
  { playerId: 'alice', color: 'BLACK', connected: true, ready: true, isHost: true },
  { playerId: 'bob', color: 'WHITE', connected: true, ready: true, isHost: false },
];
const versionedRoomSnapshot = (type = 'ROOM_CREATED', extra = {}) => ({
  type, roomId: '123456', status: 'in_progress', matchPhase: 'PLAYING', hostPlayerId: 'alice',
  settings: { ...roomSettings }, players: structuredClone(connectedRoomPlayers),
  matchState: { settings: { ...roomSettings }, actions: [] }, countdownEndsAt: null, serverTimestamp: 1000,
  yourPlayerId: 'alice', playerId: 'alice', yourColor: 'BLACK', color: 'BLACK', actionProtocolVersion: 1,
  serverInstanceId: 'server-session-integration', roomInstanceId: 'room-session-integration', matchGeneration: 1,
  matchEpoch: 'epoch-session-integration', actionSeq: 0, roomRevision: 1, ...extra,
});
async function createVersionedRoom(platform, { initialActions = [] } = {}) {
  const page = await openPage(platform, { realVue: true, controlledWorkers: true, auth: { token: 'fixture-mobile-token', username: 'alice' } });
  page.context.__LIFELINE_RUNTIME_CONFIG__ = { ...page.context.__LIFELINE_RUNTIME_CONFIG__, websocketUrl: 'ws://127.0.0.1:19999/ws' };
  page.context.localStorage.setItem('lifeline-tutorial-dismissed-v1', '1');
  const sockets = [];
  class RoomFixtureSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = RoomFixtureSocket.CONNECTING; this.sent = []; sockets.push(this); queueMicrotask(() => this.open()); }
    send(text) {
      this.sent.push(JSON.parse(text));
      const request = this.sent.at(-1);
      queueMicrotask(() => {
        if (this.readyState !== RoomFixtureSocket.OPEN) return;
        if (request.type === 'action_protocol_hello') this.message({ type: 'ACTION_PROTOCOL_SELECTED', version: 1, serverInstanceId: 'server-session-integration' });
        else if (request.type === 'join_room') this.message(versionedRoomSnapshot('ROOM_JOINED', initialActions.length ? {
          actionSeq: initialActions.length, roomRevision: initialActions.length + 1,
          matchState: { settings: { ...roomSettings }, actions: structuredClone(initialActions) },
        } : {}));
      });
    }
    open() { if (this.readyState !== RoomFixtureSocket.CONNECTING) return; this.readyState = RoomFixtureSocket.OPEN; this.dispatchEvent(new Event('open')); }
    message(payload) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) })); }
    close(code = 1000, reason = 'fixture_closed') { this.readyState = RoomFixtureSocket.CLOSED; this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: true })); }
  }
  page.context.WebSocket = RoomFixtureSocket;
  const mounted = await page.mountApp();
  // Room controls are reachable after the opening tutorial, which owns session
  // state until it is dismissed. Use the actual App dismissal path.
  if (mounted.app.tutorialActive.value) await mounted.app.skipTutorial();
  Object.assign(mounted.controller, {
    canvas: { ...mounted.controller.canvas, classList: { toggle() {} } },
    _preparedMatchStates: new Map(), _preparedOnlineActions: new Map(), _preparedTransactionSequence: 0,
    _lastVersionedRestore: null, _onlineActionSync: null, _onlineActionPlayerId: null,
    _onlineActionRecoveryListener: null, _onlineActionSendingListener: null, _onlineActionBindingRevision: 0,
  });
  mounted.app.roomIdInput.value = '123456';
  await mounted.app.handleJoinRoom();
  await drainAppEvents();
  const socket = sockets.at(-1);
  assert.ok(socket, 'the real App creates its authenticated room WebSocket');
  assert.ok(socket.sent.some(({ type }) => type === 'action_protocol_hello'), 'the real App negotiates the versioned action protocol');
  assert.ok(socket.sent.some(({ type }) => type === 'join_room'), 'the real App joins an existing versioned room after negotiation');
  assert.equal(mounted.app.session.value.roomId, '123456', `the room snapshot establishes the actual App session (status=${mounted.app.roomStatus.value}, error=${mounted.app.networkError.value}, room=${JSON.stringify(mounted.app.roomInfo.value)}, sent=${JSON.stringify(socket.sent)})`);
  return { page, mounted, socket };
}
async function createLegacyRoom(platform) {
  const page = await openPage(platform, { realVue: true, controlledWorkers: true, auth: { token: 'fixture-mobile-token', username: 'alice' } });
  page.context.__LIFELINE_RUNTIME_CONFIG__ = { ...page.context.__LIFELINE_RUNTIME_CONFIG__, websocketUrl: 'ws://127.0.0.1:19999/ws' };
  page.context.localStorage.setItem('lifeline-tutorial-dismissed-v1', '1');
  const sockets = [];
  const legacySnapshot = (type = 'ROOM_CREATED', extra = {}) => {
    const { actionProtocolVersion, serverInstanceId, roomInstanceId, matchGeneration, matchEpoch, actionSeq, roomRevision, ...snapshot } = versionedRoomSnapshot(type, extra);
    return snapshot;
  };
  class LegacyRoomFixtureSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { super(); this.url = url; this.readyState = LegacyRoomFixtureSocket.CONNECTING; this.sent = []; sockets.push(this); queueMicrotask(() => this.open()); }
    send(text) {
      this.sent.push(JSON.parse(text));
      const request = this.sent.at(-1);
      queueMicrotask(() => {
        if (this.readyState !== LegacyRoomFixtureSocket.OPEN) return;
        if (request.type === 'action_protocol_hello') this.message({ type: 'ERROR', code: 'UNKNOWN_MESSAGE_TYPE', message: "Unsupported message type: 'action_protocol_hello'" });
        else if (request.type === 'join_room') this.message(legacySnapshot('ROOM_JOINED'));
      });
    }
    open() { if (this.readyState !== LegacyRoomFixtureSocket.CONNECTING) return; this.readyState = LegacyRoomFixtureSocket.OPEN; this.dispatchEvent(new Event('open')); }
    message(payload) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) })); }
    close(code = 1000, reason = 'fixture_closed') { this.readyState = LegacyRoomFixtureSocket.CLOSED; this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: true })); }
  }
  page.context.WebSocket = LegacyRoomFixtureSocket;
  const mounted = await page.mountApp();
  // Room controls are reachable after the opening tutorial, which owns session
  // state until it is dismissed. Use the actual App dismissal path.
  if (mounted.app.tutorialActive.value) await mounted.app.skipTutorial();
  Object.assign(mounted.controller, {
    canvas: { ...mounted.controller.canvas, classList: { toggle() {} } },
    _preparedMatchStates: new Map(), _preparedOnlineActions: new Map(), _preparedTransactionSequence: 0,
    _lastVersionedRestore: null, _onlineActionSync: null, _onlineActionPlayerId: null,
    _onlineActionRecoveryListener: null, _onlineActionSendingListener: null, _onlineActionBindingRevision: 0,
  });
  mounted.app.roomIdInput.value = '123456';
  await mounted.app.handleJoinRoom();
  await drainAppEvents();
  const socket = sockets.at(-1);
  assert.ok(socket, 'the real App creates its authenticated legacy room WebSocket');
  assert.ok(socket.sent.some(({ type }) => type === 'action_protocol_hello'), 'the real App attempts action protocol negotiation');
  assert.ok(socket.sent.some(({ type }) => type === 'join_room'), 'the real App falls back and joins the existing legacy room');
  assert.equal(mounted.controller.networkManager.getActionProtocol().status, 'legacy', 'the real NetworkManager classified the synthetic unsupported response as legacy');
  assert.equal(mounted.app.session.value.roomId, '123456', 'the accepted legacy room snapshot establishes the real App session');
  return { page, mounted, socket, legacySnapshot };
}
const drainAppEvents = async () => { for (let index = 0; index < 35; index += 1) await Promise.resolve(); await VueRuntime.nextTick(); };
const contributionStorageKey = 'lifeline-training-contribution-v1';
const pendingContributionFixture = async () => {
  // Explicit current-policy consent and a genuine completed, integrity-bound
  // replay. Older v1 consent never authorizes a v3 upload.
  const settings={playerCount:2,gridSize:5,startPlayer:'BLACK',rulesVersion:'territory-v3'};
  const replay=await createReplayDocument(settings,[{type:'player_skip'},{type:'player_skip'}]);
  assert.equal(replay.terminal?.status,'completed');
  const payload={format:'lifeline-training-contribution',version:3,consent:true,
    consent_policy:'anonymous-replay-training-v3',replay,context:{source:'local',actors:{BLACK:{kind:'human'},WHITE:{kind:'human'}},
      mixedProfiles:false,hintsEnabled:false,undo:{enabled:false,maxCount:3,usedCount:0}}};
  return JSON.stringify({policy:'anonymous-replay-training-v3',enabled:true,
    queue:[{id:replay.integrity.canonicalDocumentHash,payload}],lastReceipt:null});
};
const installNetworkStatusFixture = (page, { isNative = true } = {}) => {
  const state = { listener: null, subscribeCalls: 0, unsubscribeCalls: 0, revision: 0 };
  page.context.LifelinePlatform = Object.freeze({
    ...page.context.LifelinePlatform,
    isNative,
    subscribeNetworkStatus(listener) {
      state.subscribeCalls += 1;
      state.listener = listener;
      return () => { state.unsubscribeCalls += 1; };
    },
  });
  return state;
};
const emitNetworkStatus = async (fixture, availability) => {
  assert.equal(typeof fixture.listener, 'function', 'the native network listener is installed');
  fixture.listener({
    schemaVersion: 1, source: 'native', revision: ++fixture.revision,
    availability, validation: availability === 'available' ? 'validated' : 'unknown',
  });
  await drainAppEvents();
};

const checks=[];
const diagnostics=[];
async function check(platform,name,body){try{await body();checks.push({platform,name,status:'PASS'});}catch(error){checks.push({platform,name,status:'FAIL',error:{name:error.name,message:error.message}});}}
for(const platform of ['android','harmony']){
  for(const recoveryMode of ['live-rejection','lost-ack','replaced-controller'])await check(platform,`RATE_LIMITED feedback follows successful ${recoveryMode} rollback and stays owned`,async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      let submitted=null;
      let finishRecovery=null;
      const originalSend=socket.send.bind(socket);
      const rejectedOutcome=(clientActionId)=>({clientActionId,status:'rejected',type:'ACTION_REJECTED',actionProtocolVersion:1,
        serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
        matchEpoch:'epoch-session-integration',actionSeq:0,roomRevision:2,playerId:'alice',color:'BLACK',
        code:'RATE_LIMITED',message:'raw server message must not be displayed',retryAfterMs:250,
        action:{type:'player_skip',playerId:'alice',color:'BLACK'}});
      const syncPayload=(syncRequestId,clientActionId)=>({
        ...versionedRoomSnapshot('SYNC_STATE',{roomRevision:2,serverTimestamp:2000,syncRequestId,actionSeq:0}),
        pendingActionOutcomes:[rejectedOutcome(clientActionId)],outcomeLedgerComplete:true,
      });
      socket.send=(text)=>{
        originalSend(text);
        const request=JSON.parse(text);
        if(request.type==='player_skip'){
          submitted=request;
          if(recoveryMode!=='lost-ack')queueMicrotask(()=>socket.message({type:'ACTION_REJECTED',actionProtocolVersion:1,
            serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
            matchEpoch:'epoch-session-integration',actionSeq:0,roomRevision:2,clientActionId:request.clientActionId,
            playerId:'alice',color:'BLACK',code:'RATE_LIMITED',message:'raw server message must not be displayed',
            action:{type:'player_skip',playerId:'alice',color:'BLACK'}}));
        }else if(request.type==='sync_state')queueMicrotask(()=>{finishRecovery=()=>socket.message(syncPayload(request.syncRequestId,request.pendingActionIds[0]));});
      };
      const actionPromise=mounted.app.handleSkip();
      await flushMicrotasks();
      assert.ok(submitted,'the real App/controller sends a v1 action');
      if(recoveryMode==='lost-ack'){
        const ack=[...page.timers].find(([,timer])=>timer.delay===5000);
        assert.ok(ack,'the coordinator owns an ACK timeout for the pending action');
        page.fireTimer(ack[0]);
      }
      await actionPromise;
      await drainAppEvents();
      assert.equal(typeof finishRecovery,'function','the live rejection or ACK timeout starts a SYNC_STATE recovery');
      const rateText='操作过快，本次操作未被记录。棋局已同步，请稍后重新操作。';
      assert.notEqual(mounted.app.actionFeedback.value,rateText,'the notice waits until the authoritative snapshot has committed');
      if(recoveryMode==='replaced-controller'){
        const previousController=mounted.controller;
        const replacement=Object.assign(Object.create(Object.getPrototypeOf(previousController)),{
          ...previousController,engine:new mounted.GameEngine(roomSettings),_engineEpoch:previousController._engineEpoch+1,
          _networkUnsubscribers:[],_onlineActionSync:null,_onlineActionSyncCoordinator:null,
        });
        mounted.app.handleControllerReady(replacement);
      }
      finishRecovery();
      await drainAppEvents();
      if(recoveryMode==='replaced-controller'){
        assert.notEqual(mounted.app.actionFeedback.value,rateText,'a delayed rejection from a replaced controller cannot publish stale feedback');
        return;
      }
      assert.equal(mounted.app.actionFeedback.value,rateText,'only a successful validated rollback presents the localized rejection');
      assert.equal(mounted.controller._onlineActionSync.getState().pending.length,0,'a rejected ID is removed and not retried');
      assert.equal(socket.sent.filter(item=>item.type==='player_skip').length,1,'recovery never resends the rejected ID');
      assert.doesNotMatch(mounted.app.actionFeedback.value,/raw server message|250|ms|毫秒/i,'wire message and historical estimate stay out of UI');

      mounted.app.language.value='en';await drainAppEvents();
      const englishRateText='Too many actions. This action was not recorded. The game is synced; please wait briefly before trying again.';
      assert.equal(mounted.app.actionFeedback.value,englishRateText,'the committed notice follows the selected language');
      mounted.app.handleStateChange(mounted.controller.getGameState());
      assert.equal(mounted.app.actionFeedback.value,englishRateText,'a normal state refresh preserves the committed rejection notice');

      mounted.controller.actionFeedbackListener({success:false,reason:'INVALID_MOVE',type:'move'});
      assert.notEqual(mounted.app.actionFeedback.value,englishRateText,'the next action feedback replaces the owned rate notice');
      await mounted.app.handleLeaveRoom();await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'solo','leaving the room returns the App to local play');
      assert.notEqual(mounted.app.actionFeedback.value,rateText,'leaving the room clears Chinese rate-limited feedback');
      assert.notEqual(mounted.app.actionFeedback.value,englishRateText,'leaving the room clears English rate-limited feedback even if save-clear feedback replaces it');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'unknown and pending action notices follow current App state, language, and room leave',async()=>{
    const {page,mounted}=await createVersionedRoom(platform);
    try{
      const baseState=mounted.controller.getGameState();
      mounted.app.handleStateChange({...baseState,interactionLocked:true,interactionLockReason:'ACTION_OUTCOME_UNKNOWN'});
      assert.match(mounted.app.boardHint.value,/无法确认上一动作是否已生效/,'the first uncertain lock immediately explains the unknown outcome');
      assert.match(mounted.app.boardHint.value,/重新连接查询|离开房间返回本地对局/,'the hint explains both safe next steps');
      mounted.controller.actionFeedbackListener({success:false,reason:'ACTION_OUTCOME_UNKNOWN',type:'move'});
      assert.match(mounted.app.actionFeedback.value,/无法确认上一动作是否已生效/,'the blocked-pointer feedback has explicit unknown wording');
      mounted.app.language.value='en';await drainAppEvents();
      assert.match(mounted.app.boardHint.value,/could not be confirmed/i,'the lock hint follows the current language');
      assert.match(mounted.app.actionFeedback.value,/could not be confirmed/i,'the blocked-pointer feedback follows the current language');

      mounted.app.networkError.value='Independent connection notice';
      mounted.app.handleStateChange({...baseState,interactionLocked:false,interactionLockReason:null});
      assert.equal(mounted.app.actionFeedback.value,'','resolving the owned unknown lock clears its old action feedback');
      assert.equal(mounted.app.networkError.value,'Independent connection notice','clearing action feedback preserves an unrelated network notice');

      mounted.app.handleStateChange({...baseState,interactionLocked:true,interactionLockReason:'ACTION_OUTCOME_UNKNOWN'});
      mounted.controller.actionFeedbackListener({success:false,reason:'ACTION_OUTCOME_UNKNOWN',type:'move'});
      mounted.controller.actionFeedbackListener({success:false,reason:'INVALID_MOVE',type:'move'});
      const independentActionFeedback=mounted.app.actionFeedback.value;
      assert.match(independentActionFeedback,/That point is not a legal move/i,'an independent action error replaces the owned unknown feedback');
      mounted.app.language.value='zh';await drainAppEvents();
      assert.equal(mounted.app.actionFeedback.value,independentActionFeedback,'the owner language refresh does not rewrite an independent action error');
      mounted.app.handleStateChange({...baseState,interactionLocked:false,interactionLockReason:null});
      assert.equal(mounted.app.actionFeedback.value,independentActionFeedback,'resolving the unknown lock preserves independent action feedback');

      mounted.app.handleStateChange({...baseState,interactionLocked:true,interactionLockReason:'ACTION_PENDING'});
      assert.match(mounted.app.boardHint.value,/等待服务器确认/,'the new pending lock reason immediately explains it is awaiting confirmation');
      mounted.controller.actionFeedbackListener({success:false,reason:'ACTION_PENDING',type:'move'});
      assert.match(mounted.app.actionFeedback.value,/等待服务器确认/,'the new pending action reason has explicit feedback');
      mounted.app.handleStateChange({...baseState,interactionLocked:false,interactionLockReason:null});
      mounted.app.handleStateChange({...baseState,interactionLocked:true,interactionLockReason:'ROOM_ACTION_PENDING'});
      assert.match(mounted.app.boardHint.value,/等待服务器确认/,'the legacy pending lock reason remains supported');
      mounted.controller.actionFeedbackListener({success:false,reason:'ROOM_ACTION_PENDING',type:'move'});
      assert.match(mounted.app.actionFeedback.value,/等待服务器确认/,'the legacy pending action reason remains supported');
      mounted.controller.actionFeedbackListener({success:false,reason:'ROOM_ACTION_UNCONFIRMED',type:'move'});
      assert.match(mounted.app.actionFeedback.value,/无法确认上一动作是否已生效/,'the legacy unconfirmed reason maps to the corrected unknown wording');

      await mounted.app.handleLeaveRoom();
      await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'solo','leaving returns the App to local play');
      assert.doesNotMatch(mounted.app.boardHint.value,/could not be confirmed|Waiting for server confirmation|无法确认上一动作是否已生效|等待服务器确认/i,'leave does not retain the old lock hint');
      assert.doesNotMatch(mounted.app.actionFeedback.value,/could not be confirmed|Waiting for server confirmation|无法确认上一动作是否已生效|等待服务器确认/i,'leave does not retain old pending or unknown action feedback');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'no-pending capacity recovery preserves the confirmed board and save across successful leave',async()=>{
    const confirmedActions=[
      {type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-alice-1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-bob-2'},
    ];
    const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
      matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:confirmedActions});
    try{
      const confirmedPositionRevision=mounted.controller.engine.getSnapshot().positionRevision;
      assert.equal(confirmedPositionRevision,2,'the real App starts from two server-confirmed moves');
      const originalSend=socket.send.bind(socket);
      socket.send=text=>{
        originalSend(text);
        const request=JSON.parse(text);
        if(request.type==='sync_state')queueMicrotask(()=>socket.message({
          ...versionedRoomSnapshot('SYNC_STATE',{actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,
            matchState:{settings:{...roomSettings},actions:structuredClone(confirmedActions)}}),
          outcomeLedgerComplete:true,pendingActionOutcomes:[],actionOutcomeCapacity:marker,
        }));
      };

      const sync=mounted.controller._onlineActionSync;
      mounted.controller._onlineActionRecoveryListener({reason:'capacity_integration_no_pending'});
      await drainAppEvents();
      assert.equal(sync.getState().pending.length,0);
      assert.equal(sync.getState().capacityRecoveryReady,true);
      assert.match(mounted.app.boardHint.value,/已恢复到确认的棋局|confirmed board has been restored/i,'the board hint identifies capacity recovery');
      mounted.app.language.value='en';await drainAppEvents();
      assert.match(mounted.app.boardHint.value,/confirmed board has been restored/i,'the capacity hint updates with the selected language');
      mounted.app.networkError.value='Independent connection notice';
      mounted.app.handleStateChange(mounted.controller.getGameState());
      assert.equal(mounted.app.networkError.value,'Independent connection notice','capacity hint updates preserve unrelated network errors');
      await mounted.app.handleLeaveRoom();await drainAppEvents();await page.flush();
      assert.equal(mounted.app.roomStatus.value,'solo','a ready no-pending capacity recovery can leave successfully');
      assert.equal(mounted.controller.engine.getSnapshot().positionRevision,confirmedPositionRevision,'successful leave preserves the confirmed in-memory board');
      assert.equal(mounted.app.localGameActions.value.length,2,'the in-memory local history replaces an older local prefix with both confirmed room moves');
      assert.deepEqual(JSON.parse(JSON.parse(page.local).payload).actions,confirmedActions.map(({type,point})=>({type,point})),
        'successful leave persists the complete confirmed local move history');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}

  });
  await check(platform,'pending capacity recovery waits for the action send task before reconciling and leaving',async()=>{
    const confirmedActions=[
      {type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-alice-1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-bob-2'},
    ];
    const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
      matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:confirmedActions});
    try{
      const sync=mounted.controller._onlineActionSync;
      const manager=mounted.controller.networkManager;
      const trace=[];
      const wrap=(target,key,label)=>{const original=target[key].bind(target);target[key]=(...args)=>{const value=original(...args);const after=sync.getState();trace.push({label,result:value?.status??value,reason:value?.reason,revision:after.revision,pending:after.pending.map(item=>item.status),capacityBlocked:after.capacityBlocked,capacityRecoveryReady:after.capacityRecoveryReady,recoveryRequired:after.recoveryRequired});return value;};};
      wrap(sync,'markSent','markSent');
      wrap(sync,'prepareSyncRequest','prepareSyncRequest');
      wrap(sync,'prepareSyncResponse','prepareSyncResponse');
      wrap(sync,'failSyncRequest','failSyncRequest');
      wrap(sync,'commitSnapshot','commitSnapshot');
      wrap(sync,'finalizeSnapshot','finalizeSnapshot');
      const originalRequest=manager.requestActionSync.bind(manager);
      manager.requestActionSync=async request=>{trace.push({label:'requestActionSync',request});return originalRequest(request);};
      const originalSend=socket.send.bind(socket);
      socket.send=text=>{
        originalSend(text);
        const request=JSON.parse(text);
        if(request.type==='sync_state'){
          page.context.setTimeout(()=>socket.message({
            ...versionedRoomSnapshot('SYNC_STATE',{actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,
              matchState:{settings:{...roomSettings},actions:structuredClone(confirmedActions)}}),
            outcomeLedgerComplete:true,
            pendingActionOutcomes:[{clientActionId:request.pendingActionIds[0],status:'notSeen'}],
            actionOutcomeCapacity:marker,
          }),0);
        }
      };
      const actionPromise=mounted.app.handleSkip();
      await actionPromise;await drainAppEvents();
      const pending=sync.getState().pending[0];
      assert.ok(pending,'the actual App leaves the submitted action pending before server control arrives');
      const control={type:'ACTION_NOT_PROCESSED',processed:false,reason:'OUTCOME_CAPACITY',actionProtocolVersion:1,
        serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
        matchEpoch:'epoch-session-integration',clientActionId:pending.clientActionId,playerId:'alice'};
      page.context.setTimeout(()=>socket.message(control),0);
      page.runTimers(0);
      await drainAppEvents();
      assert.ok(socket.sent.some(item=>item.type==='sync_state'),'capacity control starts the real SYNC_STATE request');
      page.runTimers(0);
      await drainAppEvents();
      assert.equal(sync.getState().capacityRecoveryReady,true,`validated pending capacity recovery reaches readiness: ${JSON.stringify({trace,state:sync.getState()})}`);
      assert.equal(trace.find(item=>item.label==='prepareSyncResponse')?.result,'ready',`the SYNC_STATE response is accepted by the real Sync reducer: ${JSON.stringify(trace)}`);
      assert.equal(trace.find(item=>item.label==='commitSnapshot')?.result,'committed',`the authoritative snapshot commits: ${JSON.stringify(trace)}`);
      assert.equal(trace.find(item=>item.label==='finalizeSnapshot')?.result,'committed',`the deferred capacity snapshot finalizes: ${JSON.stringify(trace)}`);
      assert.equal(trace.some(item=>item.label==='failSyncRequest'),false,`the coordinator does not fail or discard this valid response: ${JSON.stringify(trace)}`);
      diagnostics.push({platform,name:'pending capacity response reduction',trace});
      assert.equal(sync.getState().pending[0]?.status,'capacityBlocked','a notSeen pending action remains blocked under the server capacity marker');
      await mounted.app.handleLeaveRoom();await drainAppEvents();await page.flush();
      assert.equal(mounted.app.roomStatus.value,'solo','validated pending-capacity readiness permits a successful leave');
      const saved=JSON.parse(JSON.parse(page.local).payload);
      assert.deepEqual(saved.actions,confirmedActions.map(({type,point})=>({type,point})),'successful leave persists the complete two-action confirmed history');
      const restored=new mounted.GameEngine(saved.settings);
      for(const action of saved.actions)assert.equal(restored.playMove(action.point).success,true);
      assert.equal(restored.getSnapshot().positionRevision,2,'the saved confirmed two-step game reloads with both moves');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'failed capacity leave retains the active room and confirmed board',async()=>{
    const confirmedActions=[
      {type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-alice-1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-bob-2'},
    ];
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:confirmedActions});
    try{
      const confirmedPositionRevision=mounted.controller.engine.getSnapshot().positionRevision;
      const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
        matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
      const originalSend=socket.send.bind(socket);
      socket.send=text=>{
        originalSend(text);
        const request=JSON.parse(text);
        if(request.type==='sync_state')queueMicrotask(()=>socket.message({
          ...versionedRoomSnapshot('SYNC_STATE',{actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,
            matchState:{settings:{...roomSettings},actions:structuredClone(confirmedActions)}}),
          outcomeLedgerComplete:true,pendingActionOutcomes:[],actionOutcomeCapacity:marker,
        }));
      };
      mounted.controller._onlineActionRecoveryListener({reason:'capacity_leave_retry_test'});await drainAppEvents();
      assert.equal(mounted.controller._onlineActionSync.getState().capacityRecoveryReady,true,'the test enters leave with validated capacity readiness');
      const leaveRoom=mounted.controller.networkManager.leaveRoom;
      mounted.controller.networkManager.leaveRoom=async()=>{throw new Error('Synthetic leave failure');};
      await mounted.app.handleLeaveRoom();await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'inProgress','a failed leave keeps the player in the room');
      assert.equal(mounted.controller.engine.getSnapshot().positionRevision,confirmedPositionRevision,'a failed leave leaves the confirmed board untouched');
      assert.equal(mounted.controller._onlineActionSync.getState().capacityRecoveryReady,true,'a failed leave retains capacity readiness for retry');
      assert.notEqual(mounted.app.networkError.value,'','the leave failure remains visible');
      mounted.controller.networkManager.leaveRoom=leaveRoom;
      await mounted.app.handleLeaveRoom();await drainAppEvents();await page.flush();
      assert.equal(mounted.app.roomStatus.value,'solo','retrying leave after the transient failure succeeds');
      assert.deepEqual(JSON.parse(JSON.parse(page.local).payload).actions,confirmedActions.map(({type,point})=>({type,point})),
        'the successful retry saves both confirmed moves');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'capacity-ready logout saves the complete confirmed room history',async()=>{
    const confirmedActions=[
      {type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-alice-1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-bob-2'},
    ];
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:confirmedActions});
    try{
      const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
        matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
      const originalSend=socket.send.bind(socket);
      socket.send=text=>{
        originalSend(text);
        const request=JSON.parse(text);
        if(request.type==='sync_state')queueMicrotask(()=>socket.message({
          ...versionedRoomSnapshot('SYNC_STATE',{actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,
            matchState:{settings:{...roomSettings},actions:structuredClone(confirmedActions)}}),
          outcomeLedgerComplete:true,pendingActionOutcomes:[],actionOutcomeCapacity:marker,
        }));
      };
      mounted.controller._onlineActionRecoveryListener({reason:'capacity_logout_test'});await drainAppEvents();
      assert.equal(mounted.controller._onlineActionSync.getState().capacityRecoveryReady,true);
      await mounted.app.handleLogout();await drainAppEvents();await page.flush();
      assert.equal(mounted.app.roomStatus.value,'solo','logging out leaves the room');
      assert.deepEqual(JSON.parse(JSON.parse(page.local).payload).actions,confirmedActions.map(({type,point})=>({type,point})),
        'logout saves the full confirmed room history locally');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  // These use the actual local + native envelope bridge; a confirmed local
  // write alone is not a durable mobile exit checkpoint.
  for (const fault of ['delayed-native','failed-native','changed-envelope']) await check(platform,`capacity exit protects native mirror: ${fault}`,async()=>{
    const confirmedActions=[
      {type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-alice-1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'confirmed-bob-2'},
    ];
    const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
      matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:confirmedActions});
    let release=null;
    try {
      const send=socket.send.bind(socket);
      socket.send=text=>{send(text);const request=JSON.parse(text);if(request.type==='sync_state')queueMicrotask(()=>socket.message({
        ...versionedRoomSnapshot('SYNC_STATE',{actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,
          matchState:{settings:{...roomSettings},actions:structuredClone(confirmedActions)}}),
        outcomeLedgerComplete:true,pendingActionOutcomes:[],actionOutcomeCapacity:marker}));};
      mounted.controller._onlineActionRecoveryListener({reason:'mobile_mirror_exit_test'});await drainAppEvents();
      const ledger=mounted.controller._onlineActionSync;
      assert.equal(ledger.getState().capacityRecoveryReady,true,'test begins with an authoritative recoverable board');
      await page.flush();
      const before=JSON.stringify(mounted.controller.engine.getSnapshot()),originalLeave=mounted.controller.networkManager.leaveRoom;
      let sends=0;mounted.controller.networkManager.leaveRoom=async(...args)=>{sends++;return originalLeave.apply(mounted.controller.networkManager,args);};
      if(fault==='failed-native') {
        page.failNextNative();await mounted.app.handleLeaveRoom();await drainAppEvents();
        assert.equal(sends,0,'failed durable mirror must prevent leave');
        assert.equal(mounted.app.roomStatus.value,'inProgress');
        assert.equal(JSON.stringify(mounted.controller.engine.getSnapshot()),before);
        assert.equal(ledger.getState().capacityRecoveryReady,true,'a failed mirror preserves the recovery ledger');
        await mounted.app.handleLeaveRoom();await drainAppEvents();await page.flush();
        assert.equal(sends,1,'after durable retry, a still-owned scope can leave');
        assert.equal(mounted.app.roomStatus.value,'solo');
      } else {
        const gate=page.pauseNextNative();release=gate.release;
        const leaving=mounted.app.handleLeaveRoom();
        const started=await Promise.race([gate.begun.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
        assert.equal(started,true,'leave checkpoints the confirmed game before contacting the server');
        assert.equal(sends,0,'no leave may be sent while native durability is pending');
        assert.equal(mounted.app.roomStatus.value,'inProgress');
        assert.equal(JSON.stringify(mounted.controller.engine.getSnapshot()),before);
        if(fault==='changed-envelope') {
          assert.equal(page.save(empty),true,'a concurrent local write advances the envelope');
        }
        gate.release();release=null;await leaving;await drainAppEvents();
        if(fault==='changed-envelope') {
          assert.equal(sends,0,'a changed envelope revokes the old leave checkpoint');
          assert.equal(mounted.app.roomStatus.value,'inProgress');
          assert.equal(JSON.stringify(mounted.controller.engine.getSnapshot()),before);
        } else {
          assert.equal(sends,1,'only confirmed durability with an unchanged scope permits leave');
          assert.equal(mounted.app.roomStatus.value,'solo');
          await page.flush();assert.equal(page.native,page.local);
        }
      }
    } finally { release?.();page.unmount(mounted.vueApp);page.cleanup(); }
  });
  await check(platform,'actual versioned room recovery clears the owned opponent-left notice',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      assert.notEqual(mounted.app.networkError.value,'','PLAYER_LEFT creates the actual localized notice');
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'inProgress','the accepted snapshot keeps the active room state');
      assert.equal(mounted.controller.opponentConnected,true,'the accepted snapshot restores the controller connection state');
      assert.equal(mounted.app.networkError.value,'','the matching owned notice clears after complete connected metadata commits');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'actual legacy room recovery clears the owned opponent-left notice only after a complete connected snapshot',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'','legacy PLAYER_LEFT creates the actual localized notice');
      socket.message(legacySnapshot('ROOM_STATE',{serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'inProgress','the real legacy App accepts the current-room recovery state');
      assert.equal(mounted.controller.opponentConnected,true,'the accepted complete legacy snapshot reconnects the opponent in the actual controller');
      assert.equal(mounted.app.networkError.value,'','the complete connected legacy snapshot clears its owned notice');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'incomplete legacy recovery preserves the owned opponent-left notice',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      socket.message(legacySnapshot('ROOM_STATE',{serverTimestamp:2000,players:[connectedRoomPlayers[0],{...connectedRoomPlayers[1],connected:false}]}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,notice,'an accepted but incomplete/disconnected legacy snapshot cannot clear the notice');
      assert.equal(mounted.controller.opponentConnected,false,'the incomplete legacy metadata does not report a connected opponent');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'stale legacy room metadata preserves the owned opponent-left notice',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      socket.message(legacySnapshot('ROOM_STATE',{serverTimestamp:999}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,notice,'a timestamp-regressing legacy snapshot is rejected and cannot clear the notice');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'legacy metadata for another room preserves the owned opponent-left notice',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      socket.message(legacySnapshot('ROOM_STATE',{roomId:'different-room',serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,notice,'a different room snapshot cannot clear the current room notice');
      assert.equal(mounted.app.session.value.roomId,'123456','the current session authority remains bound to the original room');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'failed legacy authoritative restore preserves the owned opponent-left notice',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      const engine=mounted.controller.engine;
      socket.message(legacySnapshot('ROOM_STATE',{serverTimestamp:2000,matchState:{settings:{...roomSettings},actions:[{type:'unrecognized-action'}]}}));await drainAppEvents();
      assert.equal(mounted.controller.engine,engine,'the invalid legacy action log is rejected without replacing the live engine');
      assert.notEqual(mounted.app.networkError.value,'','failed legacy authoritative recovery cannot leave the player without a visible warning');
      assert.match(mounted.app.networkError.value,/unsupported type/i,'the actual failed replay reports its recovery error');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'legacy room recovery does not clear an unrelated ERROR with identical notice text',async()=>{
    const {page,mounted,socket,legacySnapshot}=await createLegacyRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      socket.message({type:'ERROR',code:'SESSION_INTEGRATION_OTHER_ERROR',message:notice});await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'The server could not complete the request.','server-controlled text is replaced with a fixed safe message');
      socket.message(legacySnapshot('ROOM_STATE',{serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'The server could not complete the request.','a complete legacy recovery cannot clear an unrelated sanitized server error');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'language changes do not change opponent-left notice ownership',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      mounted.app.language.value='en';await drainAppEvents();
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'','notice ownership survives a language change before recovery');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'a fully connected replacement opponent clears the current room notice',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const replacementPlayers=[connectedRoomPlayers[0],{...connectedRoomPlayers[1],playerId:'carol'}];
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,serverTimestamp:2000,players:replacementPlayers}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'','a complete healthy current-room snapshot can replace the player who left');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  for(const [label,players] of [
    ['disconnected opponent',[connectedRoomPlayers[0],{...connectedRoomPlayers[1],connected:false}]],
    ['missing opponent',[connectedRoomPlayers[0]]],
    ['missing connected field',[connectedRoomPlayers[0],Object.fromEntries(Object.entries(connectedRoomPlayers[1]).filter(([key])=>key!=='connected'))]],
    ['duplicate player identity',[connectedRoomPlayers[0],{...connectedRoomPlayers[1],playerId:'alice'}]],
  ])await check(platform,`incomplete ${label} metadata preserves the owned notice`,async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;assert.notEqual(notice,'');
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,serverTimestamp:2000,players:structuredClone(players)}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,notice,'missing, disconnected, or duplicate identities cannot confirm reconnection');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'a different server error with identical text replaces notice ownership',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const notice=mounted.app.networkError.value;
      socket.message({type:'ERROR',code:'SESSION_INTEGRATION_OTHER_ERROR',message:notice});await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'The server could not complete the request.','server-controlled text is replaced with a fixed safe message');
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,serverTimestamp:2000}));await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'The server could not complete the request.','a recovery snapshot cannot clear an error it does not own');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'late PLAYER_LEFT from another room cannot create the current notice',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'old-room',playerId:'bob'});await drainAppEvents();
      assert.equal(mounted.app.networkError.value,'');
      assert.equal(mounted.app.roomStatus.value,'inProgress');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'failed authoritative restore cannot clear the owned notice',async()=>{
    const {page,mounted,socket}=await createVersionedRoom(platform);
    try{
      socket.message({type:'PLAYER_LEFT',roomId:'123456',playerId:'bob'});await drainAppEvents();
      const engine=mounted.controller.engine;
      const invalidAction={type:'player_move',playerId:'bob',color:'WHITE',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'invalid-actor'};
      socket.message(versionedRoomSnapshot('ROOM_STATE',{roomRevision:2,actionSeq:1,serverTimestamp:2000,matchState:{settings:roomSettings,actions:[invalidAction]}}));
      await drainAppEvents();
      assert.equal(mounted.controller.engine,engine,'the invalid authoritative action log is rejected');
      assert.notEqual(mounted.app.networkError.value,'','failed snapshot recovery cannot erase the notice');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'native network recovery retries pending contributions and replaces only recovered-room timers',async()=>{
    const page=await openPage(platform,{realVue:true,controlledWorkers:true});
    let vueApp;
    let contributionFetchCalls=0;
    try{
      page.context.localStorage.setItem(contributionStorageKey,await pendingContributionFixture());
      // The harness bypasses index.html, which normally loads mobile-config.js.
      page.context.__LIFELINE_RUNTIME_CONFIG__={...page.context.__LIFELINE_RUNTIME_CONFIG__,trainingContributionUrl:'https://fixture.invalid/api/training/contributions'};
      page.context.fetch=async(input,options={})=>{
        if(options.method==='POST'&&String(input).includes('/api/training/contributions')){
          contributionFetchCalls+=1;return {ok:false,status:503};
        }
        return {ok:true,status:200,text:async()=>'',json:async()=>({})};
      };
      const network=installNetworkStatusFixture(page);
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      await drainAppEvents();
      page.context.__LIFELINE_APP_ACTIVE__=true;
      page.dispatchLifecycle('foreground');
      await drainAppEvents();
      assert.equal(network.subscribeCalls,1,'the mounted native mobile shell subscribes once');
      assert.equal(contributionFetchCalls,1,'mount performs the existing pending-contribution retry');
      assert.equal(mounted.app.contributionState.value.pending,1,'a failed retry keeps the contribution queued');

      mounted.app.roomStatus.value='offline';
      const reconnectTimers=()=>[...page.timers.entries()].filter(([,timer])=>!timer.interval&&timer.delay===1200);
      await emitNetworkStatus(network,'available');
      assert.equal(contributionFetchCalls,2,'the first explicit native availability retries the pending contribution');
      let reconnect=reconnectTimers();
      assert.equal(reconnect.length,1,'the first explicit native availability schedules existing room recovery');
      const firstReconnectId=reconnect[0][0];

      await emitNetworkStatus(network,'available');
      await emitNetworkStatus(network,'unknown');
      await emitNetworkStatus(network,'available');
      assert.equal(contributionFetchCalls,2,'duplicate availability and unknown snapshots do not create retries');
      reconnect=reconnectTimers();
      assert.deepEqual(reconnect.map(([id])=>id),[firstReconnectId],'duplicate availability does not replace the existing room timer');

      await emitNetworkStatus(network,'unavailable');
      await emitNetworkStatus(network,'unknown');
      assert.equal(contributionFetchCalls,2,'unavailable and unknown snapshots do not retry uploads');
      assert.deepEqual(reconnectTimers().map(([id])=>id),[firstReconnectId],'non-available snapshots preserve the existing room timer');
      await emitNetworkStatus(network,'available');
      assert.equal(contributionFetchCalls,3,'an explicit unavailable-to-available edge retries the pending contribution');
      reconnect=reconnectTimers();
      assert.equal(reconnect.length,1,'recovered availability keeps exactly one room timer');
      assert.notEqual(reconnect[0][0],firstReconnectId,'recovered availability replaces the stale room timer');
      assert.equal(page.timers.has(firstReconnectId),false,'the stale room timer is cleared before replacement');

      mounted.app.roomStatus.value='solo';
      page.dispatchLifecycle('background');
      await emitNetworkStatus(network,'unavailable');
      await emitNetworkStatus(network,'available');
      assert.equal(contributionFetchCalls,3,'network snapshots delivered in the background have no product side effects');
      page.dispatchLifecycle('foreground');
      await emitNetworkStatus(network,'available');
      assert.equal(contributionFetchCalls,4,'a fresh foreground availability can retry after a background interval');

      const retainedListener=network.listener;
      page.unmount(vueApp);vueApp=null;
      assert.equal(network.unsubscribeCalls,1,'unmount cancels the native network subscription exactly once');
      retainedListener({availability:'unavailable'});
      retainedListener({availability:'available'});
      await drainAppEvents();
      assert.equal(contributionFetchCalls,4,'late native snapshots after unmount cannot retry contributions');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'a replaced native platform revokes its old network listener without recovery side effects',async()=>{
    const page=await openPage(platform,{realVue:true,controlledWorkers:true});
    let vueApp;
    let contributionFetchCalls=0;
    try{
      page.context.localStorage.setItem(contributionStorageKey,await pendingContributionFixture());
      // The harness bypasses index.html, which normally loads mobile-config.js.
      page.context.__LIFELINE_RUNTIME_CONFIG__={...page.context.__LIFELINE_RUNTIME_CONFIG__,trainingContributionUrl:'https://fixture.invalid/api/training/contributions'};
      page.context.fetch=async(input,options={})=>{
        if(options.method==='POST'&&String(input).includes('/api/training/contributions')){
          contributionFetchCalls+=1;return {ok:false,status:503};
        }
        return {ok:true,status:200,text:async()=>'',json:async()=>({})};
      };
      const network=installNetworkStatusFixture(page);
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      await drainAppEvents();
      assert.equal(contributionFetchCalls,1,'mount performs the baseline contribution retry');
      assert.equal(network.subscribeCalls,1);
      mounted.app.roomStatus.value='offline';
      const oldListener=network.listener;
      page.context.LifelinePlatform=Object.freeze({...page.context.LifelinePlatform});
      oldListener({availability:'available'});
      await drainAppEvents();
      assert.equal(network.unsubscribeCalls,1,'an old listener detects platform replacement and releases its owner');
      assert.equal(contributionFetchCalls,1,'a replaced platform cannot retry pending contributions through its old listener');
      assert.equal([...page.timers.values()].some(timer=>!timer.interval&&timer.delay===1200),false,'a replaced platform cannot schedule room recovery through its old listener');
      oldListener({availability:'unavailable'});
      oldListener({availability:'available'});
      await drainAppEvents();
      assert.equal(network.unsubscribeCalls,1,'late callbacks from the replaced platform cannot unsubscribe twice');
      assert.equal(contributionFetchCalls,1,'late callbacks from the replaced platform remain inert');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'native network recovery subscribes only for a native mobile shell',async()=>{
    const browserPage=await openPage(platform,{realVue:true,controlledWorkers:true});
    const nonNativePage=await openPage(platform,{realVue:true,controlledWorkers:true});
    let browserVueApp;
    let nonNativeVueApp;
    try{
      const browserNetwork=installNetworkStatusFixture(browserPage);
      browserVueApp=(await browserPage.mountApp(false)).vueApp;
      await drainAppEvents();
      assert.equal(browserNetwork.subscribeCalls,0,'a regular web page does not subscribe to native network status');

      const nonNativeNetwork=installNetworkStatusFixture(nonNativePage,{isNative:false});
      nonNativeVueApp=(await nonNativePage.mountApp(true)).vueApp;
      await drainAppEvents();
      assert.equal(nonNativeNetwork.subscribeCalls,0,'a mobile shell without a native bridge does not subscribe');
    }finally{
      browserPage.unmount(browserVueApp);browserPage.cleanup();
      nonNativePage.unmount(nonNativeVueApp);nonNativePage.cleanup();
    }
  });
  await check(platform,'background state delivered before App.setup prevents the first local AI computation',async()=>{
    const payload=setLocalMatch(JSON.parse(empty),{black:'minimax'});payload.playContext.aiMode='ai_black';
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='android')page.emitNativeAppState(false);
      else{page.context.__LIFELINE_APP_ACTIVE__=false;page.dispatchLifecycle('background');}
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      page.runTimers(0);
      assert.equal(page.workers.length,0,'a pre-setup background event must not start AI work');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'legacy AI play context migrates to per-seat players and keeps the match active',async()=>{
    const legacy=JSON.parse(empty);legacy.playContext.aiMode='ai_black';
    const saved=envelope(1,JSON.stringify(legacy));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony'){page.context.__LIFELINE_APP_ACTIVE__=true;page.dispatchLifecycle('foreground');}
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      assert.equal(mounted.app.localMatchStarted.value,true,'legacy non-none AI context is treated as an active match');
      assert.equal(mounted.app.activeLocalPlayers.value.BLACK.choice,'minimax','legacy AI side is mapped to current per-seat data');
      assert.equal(mounted.app.activeLocalPlayers.value.WHITE.choice,'human','legacy human side remains human');
      page.runTimers(0);
      assert.equal(page.workers.flatMap(worker=>worker.messages).length,1,'the migrated active AI turn can continue');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'a late error from a terminated Worker cannot terminate the foreground replacement',async()=>{
    const payload=setLocalMatch(JSON.parse(empty),{black:'minimax'});payload.playContext.aiMode='ai_black';
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony'){page.context.__LIFELINE_APP_ACTIVE__=true;page.dispatchLifecycle('foreground');}
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      page.runTimers(0);
      const oldWorker=page.workers[0];assert.ok(oldWorker?.messages.length===1,'initial AI request starts');
      page.dispatchLifecycle('background');assert.equal(oldWorker.terminated,true);
      page.dispatchLifecycle('foreground');page.runTimers(0);
      const currentWorker=page.workers[1];assert.ok(currentWorker?.messages.length===1,'foreground schedules one replacement request');
      oldWorker.emit({type:'ERROR',requestId:oldWorker.messages[0].requestId,message:'late old-worker failure'},'error');
      assert.equal(currentWorker.terminated,false,'stale onerror must not terminate the new Worker');
      assert.equal(page.workers.length,2,'late error must not create another Worker');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'background terminates territory Workers and foreground recomputes only the current position',async()=>{
    const saved=envelope(1,empty);
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony'){page.context.__LIFELINE_APP_ACTIVE__=true;page.dispatchLifecycle('foreground');}
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      const controller=mounted.controller;
      delete controller._cancelTerritoryRefresh;
      delete controller._scheduleTerritoryRefresh;
      controller.engine=new mounted.GameEngine({gridSize:5,playerCount:3,rulesVersion:'territory-v3',deferTerritoryUpdates:true});
      const territoryPool=new TerritoryWorkerPool(()=>new page.context.Worker('./TerritoryWorker.js'),{size:3,timeoutMs:0});
      controller._territoryWorkerSession=territoryPool;
      controller._territoryFallbackToken=0;
      const scheduleTerritoryRefresh=controller._scheduleTerritoryRefresh.bind(controller);
      controller._syncSnapshot=()=>scheduleTerritoryRefresh();
      let published=0;
      const originalStart=territoryPool.start.bind(territoryPool);
      territoryPool.start=options=>originalStart({...options,onResult:result=>{published+=1;options.onResult?.(result);}});

      const firstWorkerIndex=page.workers.length;
      const move=controller._applyMove([1,0]);
      assert.equal(move.success,true,'a foreground local move is accepted');
      const oldWorkers=page.workers.slice(firstWorkerIndex);
      assert.equal(oldWorkers.length,3,'the current territory request occupies the bounded pool');
      assert.ok(oldWorkers.every(worker=>worker.messages[0]?.type==='COMPUTE_TERRITORIES'),'each pool Worker receives a territory request');
      const oldHandler=oldWorkers[0].onmessage;
      const oldMessage=oldWorkers[0].messages[0];
      const oldResponse={type:'RESULT',requestId:oldMessage.requestId,
        positionRevision:oldMessage.serializedState.positionRevision,
        rulesVersion:oldMessage.serializedState.rulesVersion,
        currentPlayer:oldMessage.serializedState.currentPlayer,
        territoryStateRevision:oldMessage.territoryStateRevision,
        gameOver:oldMessage.gameOver,territories:{[oldMessage.players[0]]:{polygon:null,area:0,displayArea:0}}};
      const requestState=oldMessage.serializedState;
      page.dispatchLifecycle('background');
      assert.ok(oldWorkers.every(worker=>worker.terminated),'background terminates every Worker in the territory pool');

      page.dispatchLifecycle('foreground');
      const replacementWorkers=page.workers.slice(firstWorkerIndex+oldWorkers.length);
      assert.equal(replacementWorkers.length,3,'foreground creates a fresh bounded pool for the unsettled position');
      assert.ok(replacementWorkers.every(worker=>worker.messages[0]?.type==='COMPUTE_TERRITORIES'),'foreground sends territory requests');
      assert.ok(replacementWorkers.every(worker=>{
        const state=worker.messages[0].serializedState;
        return state.positionRevision===requestState.positionRevision
          && state.rulesVersion===requestState.rulesVersion
          && state.currentPlayer===requestState.currentPlayer;
      }),'foreground recomputes the same current position');

      oldHandler({data:oldResponse});
      assert.equal(published,0,'a retained late response from the terminated pool is not published');
      assert.ok(replacementWorkers.every(worker=>!worker.terminated),'a late old response cannot terminate the replacement pool');
      assert.notEqual(territoryPool.activeRequestId,null,'the replacement request remains active after the stale response');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'background cancellation preserves the user pause state of an AI duel',async()=>{
    const payload=setLocalMatch(JSON.parse(empty),{black:'minimax',white:'minimax',paused:true});payload.playContext.aiMode='ai_duel';payload.playContext.aiDuelPaused=true;
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony')page.context.__LIFELINE_APP_ACTIVE__=true;
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      page.runTimers(0);
      assert.equal(mounted.app.aiDuelPaused.value,true);
      page.dispatchLifecycle('background');page.dispatchLifecycle('foreground');page.runTimers(0);
      assert.equal(mounted.app.aiDuelPaused.value,true,'foreground must not override the explicit AI-duel pause');
      assert.equal(page.workers.length,0,'a paused AI duel remains idle after foreground');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'ordinary foreground restores an enabled turn timer once and background state blocks restarts',async()=>{
    const payload=setLocalMatch(JSON.parse(empty));payload.settings.turnTimerEnabled=true;
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony')page.context.__LIFELINE_APP_ACTIVE__=true;
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      const activeTimers=()=>[...page.timers.entries()].filter(([,timer])=>timer.interval&&timer.delay===250);
      assert.equal(mounted.app.turnTimerPhase.value,'running','the enabled local-turn timer starts while foregrounded');
      page.dispatchLifecycle('background');
      mounted.app.selectedTurnTimerEnabled.value=false;
      mounted.app.selectedTurnTimerEnabled.value=true;
      await VueRuntime.nextTick();
      assert.equal(activeTimers().length,0,'watched setting changes cannot restart a timer while backgrounded');
      page.dispatchLifecycle('foreground');
      assert.equal(mounted.app.turnTimerPhase.value,'running','ordinary foreground resumes the local-turn timer');
      assert.equal(activeTimers().length,1,'foreground creates one timer');
      const timerId=activeTimers()[0][0];
      page.dispatchLifecycle('foreground');
      assert.equal(activeTimers().length,1,'a duplicate foreground event does not create another timer');
      assert.equal(activeTimers()[0][0],timerId,'a duplicate foreground event does not restart the active timer');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'early foreground during exit acknowledgement resumes one AI computation and timer state',async()=>{
    const payload=setLocalMatch(JSON.parse(empty),{black:'minimax'});payload.playContext.aiMode='ai_black';payload.settings.turnTimerEnabled=true;
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    let releaseBackground;
    try{
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      let markStarted;
      const started=new Promise(resolve=>{markStarted=resolve;});
      const backgroundWait=new Promise(resolve=>{releaseBackground=resolve;});
      page.context.LifelinePlatform=Object.freeze({...page.context.LifelinePlatform,moveToBackground:()=>{markStarted();return backgroundWait;}});
      mounted.app.handleMobileBack({preventDefault(){}});
      const exit=mounted.app.confirmMobileExit();
      await started;
      page.dispatchLifecycle('foreground');
      assert.equal(page.workers.length,0,'foreground cannot start AI while the native exit call is pending');
      assert.equal(mounted.app.turnTimerPhase.value,'paused','timer remains stopped until the native exit call settles');
      releaseBackground();
      assert.equal(await exit,true,'native exit acknowledgement completes');
      page.runTimers(0);
      const requests=page.workers.flatMap(worker=>worker.messages);
      assert.equal(requests.length,1,'the active AI turn is scheduled exactly once after pending clears');
      assert.equal(mounted.controller.readOnlyMode,false,'early foreground restores controller playability');
    }finally{releaseBackground?.();page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'native acknowledgement alone does not resume play before foreground',async()=>{
    const payload=setLocalMatch(JSON.parse(empty),{black:'minimax'});payload.playContext.aiMode='ai_black';
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    let releaseBackground;
    try{
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      let markStarted;
      const started=new Promise(resolve=>{markStarted=resolve;});
      const backgroundWait=new Promise(resolve=>{releaseBackground=resolve;});
      page.context.LifelinePlatform=Object.freeze({...page.context.LifelinePlatform,moveToBackground:()=>{markStarted();return backgroundWait;}});
      mounted.app.handleMobileBack({preventDefault(){}});
      const exit=mounted.app.confirmMobileExit();
      await started;
      releaseBackground();
      assert.equal(await exit,true,'native exit acknowledgement completes');
      page.runTimers(0);
      assert.equal(page.workers.length,0,'native acknowledgement without foreground cannot start AI work');
      assert.equal(mounted.controller.readOnlyMode,true,'controller remains read-only until foreground returns');
      page.dispatchLifecycle('foreground');
      page.runTimers(0);
      assert.equal(page.workers.flatMap(worker=>worker.messages).length,1,'foreground return resumes one AI computation');
      assert.equal(mounted.controller.readOnlyMode,false,'foreground return restores controller playability');
    }finally{releaseBackground?.();page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'confirmed local save precedes mobile background and unmount invalidates a pending exit',async()=>{
    const old=envelope(1,empty);
    const page=await openPage(platform,{local:old,native:old,realVue:true,controlledWorkers:true});
    let vueApp;
    let releaseBackground;
    try{
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      assert.equal(mounted.controller._applyMove([1,0]).success,true,'a local move is accepted before exit');
      await page.flush();
      const confirmed=page.local;
      assert.equal(page.native,confirmed,'the move is durably mirrored before exit confirmation');
      let markStarted;
      const started=new Promise(resolve=>{markStarted=resolve;});
      const backgroundWait=new Promise(resolve=>{releaseBackground=resolve;});
      page.context.LifelinePlatform=Object.freeze({...page.context.LifelinePlatform,moveToBackground:()=>{markStarted();return backgroundWait;}});
      mounted.app.handleMobileBack({preventDefault(){}});
      const exit=mounted.app.confirmMobileExit();
      await started;
      const beforeUnmount=JSON.parse(page.local);
      assert.deepEqual(JSON.parse(beforeUnmount.payload).actions,[{type:'player_move',point:[1,0]}],'the confirmed move remains present while exit is pending');
      page.unmount(vueApp);vueApp=null;
      releaseBackground();
      assert.equal(await exit,false,'unmount invalidates the pending exit continuation');
      assert.deepEqual(JSON.parse(JSON.parse(page.local).payload).actions,[{type:'player_move',point:[1,0]}],'unmount preserves the confirmed local session');
      assert.equal(page.local,page.native,'unmount preserves the confirmed native session');
    }finally{releaseBackground?.();page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'background terminates hint and comparison Workers and stops replay playback',async()=>{
    const saved=envelope(1,JSON.stringify(setLocalMatch(JSON.parse(empty))));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    try{
      if(platform==='harmony'){page.context.__LIFELINE_APP_ACTIVE__=true;page.dispatchLifecycle('foreground');}
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      mounted.app.requestHint();
      const hintWorker=page.workers[0];assert.ok(hintWorker?.messages.length===1,'hint starts a one-shot Worker');
      page.dispatchLifecycle('background');
      assert.equal(hintWorker.terminated,true,'background cancels the active hint Worker');
      assert.equal(mounted.app.hintThinking.value,false);

      mounted.controller._applyMove([1,0]);
      await mounted.app.handleStartReplay('current');
      mounted.app.handleSeekReplay(0);
      page.dispatchLifecycle('foreground');
      const previousWorkerCount=page.workers.length;
      const comparisonPromise=mounted.app.runAiComparison();
      await Promise.resolve();
      assert.equal(page.workers.length,previousWorkerCount+1,'foreground replay comparison creates a Worker');
      const comparisonWorker=page.workers.at(-1);assert.ok(comparisonWorker!==hintWorker,'comparison uses a distinct Worker from the terminated hint');
      assert.equal(comparisonWorker.terminated,false,'comparison Worker is active before background cancellation');
      assert.ok(comparisonWorker?.messages.length===1,'replay comparison starts a Worker');
      const lateComparisonHandler=comparisonWorker.onmessage;
      const comparisonRequest=comparisonWorker.messages[0];
      assert.equal(typeof lateComparisonHandler,'function','comparison Worker installs its result handler');
      page.dispatchLifecycle('background');
      await comparisonPromise;
      assert.equal(comparisonWorker.terminated,true,'background cancels the active comparison Worker');
      assert.equal(mounted.app.aiComparisonBusy.value,false);
      assert.equal(mounted.app.aiComparison.value,null,'cancellation does not publish a partial comparison');
      page.dispatchLifecycle('foreground');
      lateComparisonHandler({data:{
        type:'RESULT',requestId:comparisonRequest.requestId,strategy:comparisonRequest.strategy,
        positionRevision:comparisonRequest.serializedState.positionRevision,
        rulesVersion:comparisonRequest.serializedState.rulesVersion,
        currentPlayer:comparisonRequest.serializedState.currentPlayer,
        moves:[{point:[0,0],type:'move',score:1}],modelInfo:null,
      }});
      assert.equal(mounted.app.aiComparison.value,null,'a retained valid late RESULT cannot publish a comparison');
      assert.equal(page.workers.length,previousWorkerCount+1,'late comparison result cannot start another Worker');

      page.dispatchLifecycle('foreground');
      mounted.app.handleToggleReplayPlayback();
      assert.equal(mounted.app.replayPlaying.value,true,'replay playback starts while foregrounded');
      page.dispatchLifecycle('background');
      assert.equal(mounted.app.replayPlaying.value,false,'background stops replay playback');
      assert.equal([...page.timers.values()].some(timer=>timer.interval&&timer.delay===900),false,'background clears the replay playback interval');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'real App exports a verified replay through controlled platform-share outcomes without mutating saves',async()=>{
    const payload=setLocalMatch(JSON.parse(empty));
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    const shareCalls=[];
    const shareOutcomes=[];
    const waitForShareCalls=async(count)=>{
      for(let index=0;index<200&&shareCalls.length<count;index+=1)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(shareCalls.length,count,`native share call ${count} is reached`);
    };
    try{
      page.context.LifelinePlatform=Object.freeze({
        ...page.context.LifelinePlatform,
        shareReplay(document){
          shareCalls.push(document);
          const outcome=shareOutcomes.shift();
          if(!outcome)throw new Error('Missing synthetic share outcome.');
          return outcome();
        },
      });
      page.context.__LIFELINE_APP_ACTIVE__=true;
      page.dispatchLifecycle('foreground');
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      mounted.app.language.value='en';
      await VueRuntime.nextTick();
      assert.equal(mounted.controller._applyMove([1,0]).success,true,'the real controller accepts the exported local move');
      await page.flush();
      const savedBeforeShare={local:page.local,native:page.native};

      let resolveSelected;
      shareOutcomes.push(()=>new Promise(resolve=>{resolveSelected=resolve;}));
      const selectedExport=mounted.app.handleExportReplay();
      assert.equal(mounted.app.replayBusy.value,true,'export owns the busy state while native sharing is pending');
      await waitForShareCalls(1);
      const replay=shareCalls[0];
      const validation=await validateReplayDocument(replay);
      assert.equal(validation.success,true,validation.reason);
      assert.equal(replay.config.playerCount,2);
      assert.equal(replay.config.gridSize,9);
      assert.equal(replay.config.rulesVersion,'territory-v2');
      assert.equal(JSON.stringify(replay.extensions.actors),JSON.stringify({BLACK:{kind:'human'},WHITE:{kind:'human'}}),'the exported replay retains the active seat ownership');
      assert.equal(replay.actions.length,1);
      assert.equal(JSON.stringify({type:replay.actions[0].type,actor:replay.actions[0].actor,point:replay.actions[0].point}),JSON.stringify({type:'move',actor:'BLACK',point:[1,0]}));
      resolveSelected({status:'selected',activityType:'fixture.receiver'});
      await selectedExport;
      assert.equal(mounted.app.replayBusy.value,false);
      assert.equal(mounted.app.replayError.value,'');
      assert.match(mounted.app.actionFeedback.value,/receiving app was selected/i);
      assert.equal(mounted.app.actionFeedbackTone.value,'success');

      shareOutcomes.push(async()=>({status:'returned'}));
      await mounted.app.handleExportReplay();
      assert.match(mounted.app.actionFeedback.value,/share flow returned/i);
      assert.equal(mounted.app.actionFeedbackTone.value,'success');

      shareOutcomes.push(async()=>({status:'cancelled'}));
      await mounted.app.handleExportReplay();
      assert.match(mounted.app.actionFeedback.value,/sharing was cancelled/i);
      assert.equal(mounted.app.actionFeedbackTone.value,'neutral');

      shareOutcomes.push(async()=>{throw new Error('synthetic native share failure');});
      await mounted.app.handleExportReplay();
      assert.match(mounted.app.replayError.value,/synthetic native share failure/);
      assert.equal(mounted.app.replayBusy.value,false,'a native failure releases the export busy state');

      shareOutcomes.push(async()=>undefined);
      await mounted.app.handleExportReplay();
      assert.equal(mounted.app.replayError.value,'','a new export can retry after native failure');
      assert.match(mounted.app.actionFeedback.value,/sharing has finished/i,'an opaque Harmony-style completion keeps the conservative product message');
      assert.equal(mounted.app.replayBusy.value,false,'an opaque native completion releases export busy state');

      let resolveLateSelected;
      shareOutcomes.push(()=>new Promise(resolve=>{resolveLateSelected=resolve;}));
      const lateSelectedExport=mounted.app.handleExportReplay();
      await waitForShareCalls(6);
      page.context.dispatchEvent(new page.context.CustomEvent('lifeline:storage-status',{detail:{state:'error',source:'native',operation:'saved',nativeAvailable:true}}));
      const newerFeedback=mounted.app.actionFeedback.value;
      assert.match(newerFeedback,/device-backup sync is not confirmed/i,'a storage event publishes newer visible state while sharing is pending');
      assert.equal(mounted.app.actionFeedbackTone.value,'error');
      resolveLateSelected({status:'selected',activityType:'fixture.receiver'});
      await lateSelectedExport;
      assert.equal(mounted.app.actionFeedback.value,newerFeedback,'a late share success cannot overwrite newer same-instance feedback');
      assert.equal(mounted.app.actionFeedbackTone.value,'error');
      assert.equal(shareCalls.length,6,'each export attempt reaches native sharing exactly once');
      assert.ok(shareCalls.every(({integrity})=>integrity.canonicalDocumentHash===replay.integrity.canonicalDocumentHash),'unchanged game state produces the same replay commitment');
      assert.deepEqual({local:page.local,native:page.native},savedBeforeShare,'export, cancellation and retry leave both saved-session copies byte-identical');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
  await check(platform,'pending replay export has one owner and late completion after unmount is inert',async()=>{
    const payload=setLocalMatch(JSON.parse(empty));
    const saved=envelope(1,JSON.stringify(payload));
    const page=await openPage(platform,{local:saved,native:saved,realVue:true,controlledWorkers:true});
    let vueApp;
    let rejectPendingShare;
    const shareCalls=[];
    const waitForFirstShare=async()=>{
      for(let index=0;index<200&&shareCalls.length===0;index+=1)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(shareCalls.length,1,'the first export reaches native sharing');
    };
    try{
      page.context.LifelinePlatform=Object.freeze({
        ...page.context.LifelinePlatform,
        shareReplay(document){
          shareCalls.push(document);
          if(shareCalls.length===1)return new Promise((_,reject)=>{rejectPendingShare=reject;});
          return Promise.resolve({status:'returned'});
        },
      });
      page.context.__LIFELINE_APP_ACTIVE__=true;
      page.dispatchLifecycle('foreground');
      const mounted=await page.mountApp();vueApp=mounted.vueApp;
      assert.equal(mounted.controller._applyMove([1,0]).success,true);
      await page.flush();
      const savedBeforeShare={local:page.local,native:page.native};
      const pendingExport=mounted.app.handleExportReplay();
      await waitForFirstShare();
      const importWhileExport=await mounted.app.handleImportReplay(JSON.stringify(shareCalls[0]));
      assert.equal(importWhileExport,false,'the direct import entry cannot take ownership from a pending export');
      assert.equal(mounted.app.replayDocument.value,null,'a refused import cannot publish a replay while export owns the panel');
      assert.equal(mounted.app.replayBusy.value,true,'a refused import cannot release export busy state');
      const duplicateResult=await mounted.app.handleExportReplay();
      assert.equal(duplicateResult,false,'a second export is refused while the native share owner is pending');
      assert.equal(shareCalls.length,1,'a duplicate export cannot open another system share flow');
      assert.equal(mounted.app.replayBusy.value,true,'the refused duplicate cannot release the active export busy state');

      mounted.app.actionFeedback.value='newer visible state';
      mounted.app.actionFeedbackTone.value='neutral';
      mounted.app.replayError.value='newer replay state';
      page.unmount(vueApp);vueApp=null;
      assert.equal(mounted.app.replayBusy.value,false,'unmount releases only the pending export UI owner');
      rejectPendingShare(new Error('late native failure after unmount'));
      await pendingExport;
      assert.equal(mounted.app.actionFeedback.value,'newer visible state','late export completion cannot replace newer feedback');
      assert.equal(mounted.app.actionFeedbackTone.value,'neutral');
      assert.equal(mounted.app.replayError.value,'newer replay state','late export failure cannot replace newer replay state');
      assert.equal(mounted.app.replayBusy.value,false);
      assert.deepEqual({local:page.local,native:page.native},savedBeforeShare,'late native completion cannot edit saved-session bytes');
    }finally{
      rejectPendingShare?.(new Error('test cleanup'));
      page.unmount(vueApp);page.cleanup();
    }
  });
  await check(platform,'real ReplayPanel bounds, timeout, cancellation, retry and stale reads preserve the verified replay',async()=>{
    const page=await openPage(platform);
    try{
      const {app,ReplayPanel}=await page.mountApp();
      app.tutorialActive.value=false;
      const importedA=await createReplayDocument({...JSON.parse(empty).settings,gridSize:6},[]);
      const importedB=await createReplayDocument({...JSON.parse(empty).settings,gridSize:9},[]);
      const rootPromises=[];
      const componentEvents=[];
      const panel=ReplayPanel.setup({language:'zh'},{emit:(name,payload)=>{
        componentEvents.push({name,payload});
        const handlers={
          'import-start':app.handleReplayPanelImportStart,
          'import-cancel':app.handleReplayPanelImportCancel,
          'import-error':app.handleReplayPanelImportError,
          'import-file':app.handleReplayPanelImportFile,
        };
        const result=handlers[name]?.(payload);
        if(result&&typeof result.then==='function')rootPromises.push(result);
      }});
      const encoder=new TextEncoder();
      const select=(file)=>({target:{files:file?[file]:[],value:'selected'}});
      const readFile=(document,extra={})=>{
        const text=JSON.stringify(document);
        const bytes=encoder.encode(text);
        return {size:bytes.byteLength,arrayBuffer:()=>Promise.resolve(bytes.buffer),...extra};
      };
      await panel.handleFileChange(select(readFile(importedB)));
      await Promise.all(rootPromises.splice(0));
      assert.equal(app.replaySource.value,'imported');
      assert.equal(app.replayDocument.value.config.gridSize,9);
      let verifiedDocument=app.replayDocument.value;

      let oversizedReads=0;
      await panel.handleFileChange(select({size:4_000_001,arrayBuffer:()=>{oversizedReads+=1;return Promise.resolve(new ArrayBuffer(2));}}));
      assert.equal(oversizedReads,0,'oversized files are rejected before File.arrayBuffer()');
      assert.match(app.replayError.value,/4,000,000/);
      assert.equal(app.replayDocument.value,verifiedDocument,'a failed selection preserves the verified replay');

      await panel.handleFileChange(select({size:2,arrayBuffer(){throw new Error('synthetic synchronous read failure');}}));
      assert.match(app.replayError.value,/读取棋谱失败/,'synchronous File.arrayBuffer errors are visible in Chinese');
      await panel.handleFileChange(select({size:2,arrayBuffer:()=>Promise.reject(new Error('synthetic read rejection'))}));
      assert.match(app.replayError.value,/读取棋谱失败/,'rejected file reads are visible in Chinese');
      await panel.handleFileChange(select({size:2,arrayBuffer:()=>Promise.resolve(Uint8Array.from([0xc3,0x28]).buffer)}));
      assert.match(app.replayError.value,/读取棋谱失败/,'invalid UTF-8 is rejected before replay validation');
      await panel.handleFileChange(select({size:2,arrayBuffer:()=>Promise.resolve(new Uint8Array(4_000_001).buffer)}));
      assert.match(app.replayError.value,/4,000,000/,'the actual file bytes are bounded even when the declared size is smaller');
      assert.equal(app.replayDocument.value,verifiedDocument);

      let resolveOldRead;
      const oldRead=panel.handleFileChange(select({
        size:encoder.encode(JSON.stringify(importedA)).byteLength,
        arrayBuffer:()=>new Promise(resolve=>{resolveOldRead=resolve;}),
      }));
      await Promise.resolve();
      await panel.handleFileChange(select(readFile(importedB)));
      await Promise.all(rootPromises.splice(0));
      resolveOldRead(encoder.encode(JSON.stringify(importedA)).buffer);
      await oldRead;
      await Promise.all(rootPromises.splice(0));
      assert.equal(app.replayDocument.value.config.gridSize,9,'a slow older file read cannot replace the newer selection');
      verifiedDocument=app.replayDocument.value;

      let resolveCancelledRead;
      const cancelledRead=panel.handleFileChange(select({
        size:encoder.encode(JSON.stringify(importedA)).byteLength,
        arrayBuffer:()=>new Promise(resolve=>{resolveCancelledRead=resolve;}),
      }));
      await Promise.resolve();
      await panel.handleFileChange(select(null));
      resolveCancelledRead(encoder.encode(JSON.stringify(importedA)).buffer);
      await cancelledRead;
      await Promise.all(rootPromises.splice(0));
      assert.equal(app.replayDocument.value,verifiedDocument,'empty picker cancellation invalidates pending imports and preserves the verified replay');
      assert.equal(app.replayBusy.value,false,'cancelling a pending read releases busy state');

      const originalSetTimeout=page.context.setTimeout;
      const originalClearTimeout=page.context.clearTimeout;
      let fireReadTimeout=null;
      page.context.setTimeout=(callback,delay,...args)=>{
        if(delay===30_000){fireReadTimeout=callback;return -30000;}
        return originalSetTimeout(callback,delay,...args);
      };
      page.context.clearTimeout=(id)=>id===-30000?undefined:originalClearTimeout(id);
      try{
        const hungRead=panel.handleFileChange(select({size:2,arrayBuffer:()=>new Promise(()=>{})}));
        await Promise.resolve();
        assert.equal(app.replayBusy.value,true);
        assert.equal(typeof fireReadTimeout,'function','file reads use a bounded timeout');
        fireReadTimeout();
        await hungRead;
        assert.equal(app.replayBusy.value,false,'a timed-out read does not leave the panel busy');
        assert.match(app.replayError.value,/超时/);
        await panel.handleFileChange(select(readFile(importedB)));
        await Promise.all(rootPromises.splice(0));
        assert.equal(app.replayError.value,'','a new selection can retry after a read timeout');
      verifiedDocument=app.replayDocument.value;
      }finally{
        page.context.setTimeout=originalSetTimeout;
        page.context.clearTimeout=originalClearTimeout;
      }

      let rejectUnmountedRead;
      const unmountedRead=panel.handleFileChange(select({size:2,arrayBuffer:()=>new Promise((_,reject)=>{rejectUnmountedRead=reject;})}));
      await Promise.resolve();
      const panelUnmount=page.unmounts.at(-1);
      panelUnmount();
      rejectUnmountedRead(new Error('late failure after unmount'));
      await unmountedRead;
      assert.equal(app.replayBusy.value,false,'unmount cancels the active file-import request');
      assert.equal(app.replayDocument.value.config.gridSize,9);
      assert.equal(componentEvents.some(({name,payload})=>name==='import-error'&&payload.message.includes('late failure after unmount')),false);
    }finally{page.cleanup();}
  });

  await check(platform,'real App import generation protects result, error and busy state across overlapping ReplayCodec validation',async()=>{
    const page=await openPage(platform);
    try{
      const {app}=await page.mountApp();
      app.tutorialActive.value=false;
      const settings=JSON.parse(empty).settings;
      const valid=await createReplayDocument(settings,[]);
      const invalid=structuredClone(valid);
      invalid.integrity.finalStateHash='sha256:stale-invalid-result';
      const originalCrypto=page.context.crypto;
      const realDigest=originalCrypto.subtle.digest.bind(originalCrypto.subtle);
      let firstDigestResolve;
      let secondDigestResolve;
      page.context.crypto={subtle:{digest:(algorithm,data)=>{
        const digestCall=++digestCalls;
        if(digestCall===1)return new Promise((resolve,reject)=>{firstDigestResolve=()=>realDigest(algorithm,data).then(resolve,reject);});
        if(digestCall===2)return new Promise((resolve,reject)=>{secondDigestResolve=()=>realDigest(algorithm,data).then(resolve,reject);});
        return realDigest(algorithm,data);
      }}};
      let digestCalls=0;
      try{
        const staleFailure=app.handleImportReplay(JSON.stringify(invalid));
        await Promise.resolve();
        assert.equal(typeof firstDigestResolve,'function','the first real ReplayCodec validation reached async hashing');
        const newerSuccess=app.handleImportReplay(JSON.stringify(valid));
        await Promise.resolve();
        assert.equal(typeof secondDigestResolve,'function','the newer real ReplayCodec validation started while the first is pending');
        firstDigestResolve();
        await staleFailure;
        assert.equal(app.replayBusy.value,true,'a stale finally block cannot clear a newer import busy state');
        secondDigestResolve();
        await newerSuccess;
        assert.equal(app.replayBusy.value,false);
        assert.equal(app.replayError.value,'','an older validation failure cannot replace a newer success');
        assert.equal(app.replayDocument.value.integrity.finalStateHash,valid.integrity.finalStateHash);
      }finally{
        page.context.crypto=originalCrypto;
      }

      let rejectStaleDigest;
      digestCalls=0;
      page.context.crypto={subtle:{digest:(algorithm,data)=>{
        const digestCall=++digestCalls;
        if(digestCall===1)return new Promise((_,reject)=>{rejectStaleDigest=()=>reject(new Error('late stale digest failure'));});
        return realDigest(algorithm,data);
      }}};
      try{
        const staleError=app.handleImportReplay(JSON.stringify(valid));
        for(let index=0;index<8;index++)await Promise.resolve();
        assert.equal(typeof rejectStaleDigest,'function','the stale validation is waiting in the real ReplayCodec hash path');
        const latestSuccess=app.handleImportReplay(JSON.stringify(valid));
        await latestSuccess;
        rejectStaleDigest();
        await staleError;
        assert.equal(app.replayError.value,'','a late stale validation exception cannot replace the latest result');
        assert.equal(app.replayDocument.value.integrity.finalStateHash,valid.integrity.finalStateHash);
      }finally{
        page.context.crypto=originalCrypto;
      }

      let releaseContextCheck;
      let contextDigestDelayed=false;
      digestCalls=0;
      const replayBeforeContextChange=app.replayDocument.value;
      page.context.crypto={subtle:{digest:(algorithm,data)=>{
        if(contextDigestDelayed)return realDigest(algorithm,data);
        contextDigestDelayed=true;
        return new Promise((resolve,reject)=>{releaseContextCheck=()=>realDigest(algorithm,data).then(resolve,reject);});
      }}};
      try{
        const wrongContext=app.handleImportReplay(JSON.stringify(valid));
        for(let index=0;index<8;index++)await Promise.resolve();
        assert.equal(typeof releaseContextCheck,'function','context test is pending real ReplayCodec validation');
        app.tutorialActive.value=true;
        releaseContextCheck();
        await wrongContext;
        assert.equal(app.replayDocument.value,replayBeforeContextChange,'a result finishing in tutorial mode is discarded');
      }finally{
        page.context.crypto=originalCrypto;
      }
    }finally{page.cleanup();}
  });

  await check(platform,'explicit clear preserves evidence on local failure and removes legacy marker before restart',async()=>{
    const original=envelope(5,moved);
    const page=await openPage(platform,{local:original,native:original,legacyCleared:true});
    assert.equal(page.context.__LIFELINE_STORAGE_STATUS__.state,'conflict');
    page.failNextLocal();
    assert.equal(page.clear(),false,'a failed local clear must not be reported as successful');
    assert.equal(page.local,original,'a failed local clear must preserve the old envelope');
    assert.equal(page.native,original,'a failed local clear must preserve the native acknowledgement');
    assert.equal(page.legacyClear,'1','a failed local clear must preserve the legacy clear marker');
    assert.equal(page.clear(),true);await page.flush();
    assert.equal(page.legacyClear,null,'a committed revisioned clear supersedes and removes the legacy marker');
    assert.equal(JSON.parse(page.local).revision,6);assert.equal(JSON.parse(page.local).state,'cleared');assert.equal(page.native,page.local);
    const restarted=await openPage(platform,{local:page.local,native:page.native,legacyCleared:page.legacyClear==='1'});
    assert.equal(restarted.context.__LIFELINE_STORAGE_STATUS__.state,'cleared');
    assert.equal(restarted.load(),null);
    assert.equal(restarted.save(empty),true);await restarted.flush();
    assert.equal(JSON.parse(restarted.local).revision,7);assert.equal(restarted.local,restarted.native);
  });
  await check(platform,'actual external game module uses the initialized authority',async()=>{
    const page=await openPage(platform);
    assert.equal(page.save(empty),true);await page.flush();
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,nativeAvailable:page.context.__LIFELINE_STORAGE_STATUS__.nativeAvailable,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'confirmed',nativeAvailable:true,source:'native',operation:'saved'},'native acknowledgement identifies the saved record operation');
    assert.equal(JSON.parse(page.local).format,'lifeline-local-session-envelope');
    assert.equal(JSON.parse(page.local).revision,1);assert.equal(page.native,page.local);
    assert.equal(page.calls.filter(call=>call.operation==='saveRecord').length,1,'one actual native write per game save');
    assert.equal(page.clear(),true);await page.flush();assert.equal(JSON.parse(page.local).state,'cleared');assert.equal(JSON.parse(page.native).revision,2);assert.equal(page.load(),null);
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'cleared',source:'native',operation:'cleared'},'native clear confirms a persisted clear marker');
    assert.equal(page.save(moved),true);await page.flush();assert.equal(JSON.parse(page.local).revision,3);assert.equal(page.native,page.local);assert.equal(page.load().actions.length,1);
  });
  await check(platform,'actual App.setup exposes the mobile-shell footer branch in both modes',async()=>{
    const page=await openPage(platform);
    const mobileApp=await page.mountApp(true);
    assert.equal(mobileApp.app.mobileShell,true,'mobile App.setup exposes the mobile notices footer condition');
    const webApp=await page.mountApp(false);
    assert.equal(webApp.app.mobileShell,false,'web App.setup exposes the public filing footer condition');
  });
  await check(platform,'actual App.setup loads installed metadata, reports failure and isolates a closed request after reopening',async()=>{
    let resolveOld;
    let resolveAfterUnmount;
    let rejectFailure;
    let call=0;
    const page=await openPage(platform,{appInfoProvider:()=>{
      call+=1;
      if(call===1)return new Promise(resolve=>{resolveOld=resolve;});
      if(call===2)return Promise.resolve({version:'2.4.1',build:'17'});
      if(call===3)return new Promise((_resolve,reject)=>{rejectFailure=reject;});
      if(call===5)return new Promise(resolve=>{resolveAfterUnmount=resolve;});
      return new Promise(()=>{});
    },realVue:true,controlledWorkers:true});
    const mounted=await page.mountApp(true);
    let unmounted=false;
    try{
      const app=mounted.app;
      app.handleOpenAbout();
      assert.equal(app.aboutAppInfoState.value,'loading');
      await flushMicrotasks();
      const firstTimeout=[...page.timers].filter(([,timer])=>timer.delay===30_000).at(-1);
      assert.ok(firstTimeout,'About request owns a bounded 30-second wait timer');
      app.handleCloseUtilityDeck();
      assert.equal(page.timers.has(firstTimeout[0]),false,'closing the About panel clears its request timer');
      app.handleOpenAbout();
      await flushMicrotasks();
      assert.deepEqual({...app.aboutAppInfo.value},{platform:platform==='harmony'?'harmonyos':'android',version:'2.4.1',build:'17'});
      resolveOld({version:'stale-version',build:'stale-build'});
      await flushMicrotasks();
      assert.deepEqual({...app.aboutAppInfo.value},{platform:platform==='harmony'?'harmonyos':'android',version:'2.4.1',build:'17'},'late completion from the closed panel cannot replace reopened metadata');
      app.handleOpenAbout();
      await flushMicrotasks();
      rejectFailure(new Error('installed metadata unavailable'));
      await flushMicrotasks();
      assert.equal(app.aboutAppInfoState.value,'error','native metadata rejection is represented in the About panel');
      app.handleOpenAbout();
      await flushMicrotasks();
      const timeoutEntry=[...page.timers].filter(([,timer])=>timer.delay===30_000).at(-1);
      assert.ok(timeoutEntry,'a native request that never calls back remains bounded');
      assert.equal(page.fireTimer(timeoutEntry[0]),true,'simulated 30,001 ms deadline fires the About timeout');
      assert.equal(app.aboutAppInfoState.value,'error','a missing native callback exits loading with a visible error state');
      app.handleCloseUtilityDeck();
      assert.equal(page.timers.has(timeoutEntry[0]),false,'closing after timeout leaves no About timer behind');
      app.handleOpenAbout();
      await flushMicrotasks();
      const unmountTimeout=[...page.timers].filter(([,timer])=>timer.delay===30_000).at(-1);
      assert.ok(unmountTimeout,'pending About request owns a timer before unmount');
      page.unmount(mounted.vueApp);unmounted=true;
      assert.equal(page.timers.has(unmountTimeout[0]),false,'unmount clears the About request timer');
      resolveAfterUnmount({version:'late-after-unmount',build:'99'});
      await flushMicrotasks();
      assert.equal(app.aboutAppInfo.value,null,'completion after unmount is ignored');
    }finally{if(!unmounted)page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'newer native save wins and next game save advances revision',async()=>{
    const page=await openPage(platform,{local:envelope(3,empty),native:envelope(5,moved)});await page.flush();
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'restored',source:'native',operation:'restore'},'native recovery identifies its source and restore operation');
    assert.equal(page.local,envelope(5,moved));assert.equal(page.native,page.local);assert.equal(page.load().actions.length,1);
    assert.equal(page.save(moved),true);await page.flush();assert.equal(JSON.parse(page.local).revision,6);assert.equal(page.native,page.local);
  });
  await check(platform,'equal durable copies load locally without taking the native restore route',async()=>{
    const equal=envelope(5,moved);
    const page=await openPage(platform,{local:equal,native:equal});await page.flush();
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'confirmed',source:'local',operation:'load'},'equal durable copies select the already-present local envelope');
    assert.equal(page.local,equal);assert.equal(page.native,equal);assert.equal(page.load().actions.length,1);
  });
  await check(platform,'newer native clear does not resurrect a stale local save',async()=>{
    const page=await openPage(platform,{local:envelope(5,moved),native:envelope(6,null)});await page.flush();assert.equal(page.local,envelope(6,null));assert.equal(page.load(),null);
  });
  await check(platform,'same revision disagreement preserves both originals and blocks autosave',async()=>{
    const local=envelope(6,empty),native=envelope(6,moved);
    const page=await openPage(platform,{local,native});await page.flush();assert.equal(page.save(empty),false);assert.equal(page.local,local);assert.equal(page.native,native);assert.equal(page.calls.filter(call=>call.operation==='saveRecord').length,0);
  });
  await check(platform,'failed local write retains acknowledged copies and is not sent to native',async()=>{
    const page=await openPage(platform,{local:envelope(5,empty),native:envelope(5,empty)});await page.flush();const old=page.local;page.failNextLocal();assert.equal(page.save(moved),false);await page.flush();assert.equal(page.local,old);assert.equal(page.native,old);assert.equal(page.calls.filter(call=>call.operation==='saveRecord').length,0);
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'error',source:'local',operation:'saved'},'local write failure is distinguished from native sync failure');
    assert.equal(page.save(moved),true);await page.flush();assert.equal(JSON.parse(page.local).revision,6);assert.equal(page.native,page.local);
  });
  await check(platform,'failed native write preserves last native acknowledgement and rejects flush',async()=>{
    const old=envelope(5,empty);const page=await openPage(platform,{local:old,native:old});await page.flush();page.failNextNative();assert.equal(page.save(moved),true);await assert.rejects(page.flush());assert.equal(page.native,old);assert.equal(JSON.parse(page.local).revision,6);
    assert.deepEqual({state:page.context.__LIFELINE_STORAGE_STATUS__.state,source:page.context.__LIFELINE_STORAGE_STATUS__.source,operation:page.context.__LIFELINE_STORAGE_STATUS__.operation},
      {state:'error',source:'native',operation:'saved'},'native write failure remains distinguishable');
    assert.equal(page.save(moved),true);await page.flush();assert.equal(JSON.parse(page.native).revision,7);assert.equal(page.local,page.native);
  });
  await check(platform,'both real legacy tombstones remain distinguishable from missing',async()=>{
    const tombstone=platform==='android'?'__LIFELINE_CLEARED_V1__':'__lifeline_native_session_cleared_v1__';
    const page=await openPage(platform,{local:moved,native:tombstone});await page.flush();assert.equal(page.save(empty),false);assert.equal(page.local,moved);assert.equal(page.native,tombstone);
  });
  await check(platform,'late acknowledgement for an older save cannot erase a newer local write failure',async()=>{
    const page=await openPage(platform);const pause=page.pauseNextNative();
    try{
      assert.equal(page.save(empty),true);await pause.begun;
      page.failNextLocal();assert.equal(page.save(moved),false);
      assert.equal(page.context.__LIFELINE_STORAGE_STATUS__.state,'error');
      pause.release();await page.flush();
      assert.notEqual(page.context.__LIFELINE_STORAGE_STATUS__.state,'confirmed','older native acknowledgement must not replace the newer unsaved-state error');
    }finally{pause.release();}
  });
  await check(platform,'real app retains failed-save move and later persists full game history',async()=>{
    const old=envelope(5,empty);const page=await openPage(platform,{local:old,native:old});
    try{
      const {app,controller,GameEngine}=await page.mountApp();
      assert.equal(app.tutorialActive.value,false);
      page.failNextLocal();assert.equal(controller._applyMove([1,0]).success,true);
      const failedActionCount=app.localGameActions.value.length;
      const failureNotice=app.localGameResumeNotice.value;
      assert.equal(page.local,old,'failed write preserves prior record');assert.equal(page.native,old);
      assert.equal(controller.skipTurn().success,true);await page.flush();
      const saved=page.load();
      assert.equal(failedActionCount,1,'the accepted move remains in memory even though its write failed');
      assert.match(failureNotice,/存档写入失败|save failed/i,'a local persistence error is observable through the rendered resume-notice channel');
      assert.equal(saved.actions.length,2,'next successful write contains both accepted actions');
      const restored=new GameEngine(saved.settings);
      for(const action of saved.actions){if(action.type==='player_move')assert.equal(restored.playMove(action.point).success,true);else if(action.type==='player_skip')assert.equal(restored.skipTurn().success,true);else assert.equal(restored.resignPlayer(action.color).success,true);}
      assert.equal(JSON.stringify(restored.getSnapshot().boardMatrix),JSON.stringify(controller.engine.getSnapshot().boardMatrix));
      assert.equal(JSON.stringify([...restored.historyHashes]),JSON.stringify([...controller.engine.historyHashes]));
      assert.equal(restored.getCurrentPlayer(),controller.engine.getCurrentPlayer());assert.equal(page.local,page.native);
    }finally{page.cleanup();}
  });
  await check(platform,'actual App.setup prevents skip reentry and stale completion cannot release newer action',async()=>{
    const page=await openPage(platform,{realVue:true,controlledWorkers:true,auth:{token:'fixture-mobile-token',username:'fixture-player'}});let vueApp;
    const createManager=(rejectSkip=false)=>{
      const listeners=new Map();let resolveSkip;let calls=0;
      const manager={
        socket:{},isConnected:()=>true,sendMove:async()=>({}),sendReset:async()=>({}),sendResign:async()=>({}),
        sendSkip(){calls+=1;if(rejectSkip){const error=new Error('Explicit rejection');error.code='NOT_YOUR_TURN';return Promise.reject(error);}return new Promise(resolve=>{resolveSkip=resolve;});},
        on(event,listener){const group=listeners.get(event)??new Set();group.add(listener);listeners.set(event,group);return()=>group.delete(listener);},
        emit(event,payload={}){for(const listener of listeners.get(event)??[])listener(payload);},
        resolveSkip(){resolveSkip?.({type:'TURN_SKIPPED'});},
        get calls(){return calls;},
      };
      return manager;
    };
    try{
      const mounted=await page.mountApp();vueApp=mounted.vueApp;const {app,controller}=mounted;
      await selectLegacyProtocolThroughWire(page,app,controller);
      const firstManager=createManager();
      controller.enableMultiplayer({localPlayer:'BLACK',roomReady:true,opponentConnected:true,networkManager:firstManager});
      app.roomStatus.value='inProgress';app.handleStateChange(controller.getGameState());
      const firstSkip=app.handleSkip();await Promise.resolve();
      assert.equal(firstManager.calls,1,'the first manual skip reaches the room manager');
      assert.equal(app.networkBusy.value,true,'the page exposes the in-flight request');
      await app.handleSkip();
      assert.equal(firstManager.calls,1,'page-level reentry while busy does not send a duplicate');

      const leave=app.handleLeaveRoom();await leave;
      const secondManager=createManager();
      controller.enableMultiplayer({localPlayer:'BLACK',roomReady:true,opponentConnected:true,networkManager:secondManager});
      app.roomStatus.value='inProgress';app.handleStateChange(controller.getGameState());
      const secondSkip=app.handleSkip();await Promise.resolve();
      assert.equal(secondManager.calls,1,'a fresh room action can start after leaving the previous room');
      firstManager.resolveSkip();await firstSkip;
      assert.equal(app.networkBusy.value,true,'the stale finally from the prior room cannot clear the newer busy state');
      secondManager.emit('TURN_SKIPPED');secondManager.resolveSkip();await secondSkip;
      assert.equal(app.networkBusy.value,false,'the current confirmed action clears its own busy state');
      assert.equal(app.gameState.value.roomOperationPending,false,'the page retains the unlocked confirmed state');
      assert.equal(app.gameState.value.resetLocked,false,'confirmed state does not preserve a stale reset lock');

      const rejectingManager=createManager(true);
      controller.enableMultiplayer({localPlayer:'WHITE',roomReady:true,opponentConnected:true,networkManager:rejectingManager});
      app.handleStateChange(controller.getGameState());
      await app.handleSkip();
      assert.equal(rejectingManager.calls,1,'an explicit rejection reaches the server once');
      assert.equal(app.networkBusy.value,false,'explicit rejection releases the page busy state');
      assert.equal(app.gameState.value.skipLocked,false,'the page receives the unlocked rejection state');
      await app.handleSkip();
      assert.equal(rejectingManager.calls,2,'an explicit rejection remains retryable');
    }finally{page.unmount(vueApp);page.cleanup();}
  });
}
const after=await hashes();assert.deepEqual(after,before,'Reviewed output changed while testing; do not accept this run');
const result={schema:'lifeline-parent-envelope-entry-v1',time:new Date().toISOString(),status:checks.some(check=>check.status==='FAIL')?'FAIL':'PASS-SCOPED',scope:'Actual generated entry and both platform JS bundles; game LocalGameSession under its exact browser URL; real OnlineApp/controller failure path. Lifecycle cases mount the actual Vue runtime with controlled timers and Worker doubles; native runtimes NOT-RUN.',dist,source_hashes:before,source_hashes_stable:true,checks,diagnostics};
if (receiptPath) await writeFile(receiptPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));if(result.status==='FAIL')process.exitCode=1;
