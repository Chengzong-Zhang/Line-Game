import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'mobile/dist');
const { createReplayDocument, validateReplayDocument } = await import(pathToFileURL(path.join(dist, 'ReplayCodec.js')).href);
const { default: TerritoryWorkerPool } = await import(pathToFileURL(path.join(dist, 'TerritoryWorkerPool.js')).href);
const fixtureVue = process.argv[4];
if (!fixtureVue) throw new Error('Pass the Vue runtime entry as the fourth argument.');
const VueRuntime = await import(pathToFileURL(fixtureVue).href);
const receiptPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const version = '20261013-full-features1';
const key = 'lifeline-local-game-session-v1';
const clearKey = 'lifeline-local-game-session-cleared-v1';
const topologyKey = 'lifeline-topology-local-game-session-v1';
const sourceNames = ['mobile-entry.js','platform/mobile-bridge.js','platform/harmony-bridge.js','platform/harmony-native-bridge.js','platform/platform-selection.js','platform/session-authority.js','platform/session-envelope.js','platform/session-mirror.js','main.js','index.html','OnlineApp.js','OnlineAppState.js','ReplayCodec.js','LocalGameSession.js','GameController.js','GameEngine.js','NetworkManager.js','CrossPlatformNetwork.js','SharedRoomClient.js','OnlineActionSync.js','OnlineActionSyncCoordinator.js','OnlineRoomSync.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name,hash(await readFile(path.join(dist,name)))])));
const before = await hashes();
const session = actions => JSON.stringify({format:'lifeline-local-session',schemaVersion:1,savedAt:1,settings:{playerCount:2,gridSize:9,startPlayer:'BLACK',rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,hintEnabled:true,hintMaxCount:3},actions,playContext:{aiMode:'none',aiDepth:3,aiStrategy:'minimax',aiModelVersion:'2026092201',aiSeed:null,aiDuelPaused:false,tutorialDismissed:true}});
const decodeSaved = raw => { const value=JSON.parse(raw); return value.payload ? JSON.parse(value.payload) : value; };
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
  if (auth) context.localStorage.setItem('triaxis-auth', JSON.stringify(auth));
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
    async mountApp(mobileShell=false){
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
  assert.ok(socket, `the real App creates its authenticated room WebSocket error=${mounted.app.networkError.value} tutorial=${mounted.app.tutorialActive.value} session=${JSON.stringify(mounted.app.session.value)} auth=${JSON.stringify(mounted.app.auth.value)} input=${mounted.app.roomIdInput.value}`);
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
  assert.ok(socket, `the real App creates its authenticated legacy room WebSocket error=${mounted.app.networkError.value} tutorial=${mounted.app.tutorialActive.value}`);
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
for(const platform of ['web-vm']){
  await check(platform,'late join response cannot revive a canceled room request',async()=>{
    const page=await openPage(platform,{realVue:true,controlledWorkers:true,auth:{token:'fixture-mobile-token',username:'alice'}});
    const sockets=[];
    class HeldJoinSocket extends EventTarget {
      static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
      constructor(url){super();this.url=url;this.readyState=0;this.sent=[];sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
      send(text){const msg=JSON.parse(text);this.sent.push(msg);if(msg.type==='action_protocol_hello')queueMicrotask(()=>this.message({type:'ACTION_PROTOCOL_SELECTED',version:1,serverInstanceId:'server-session-integration'}));}
      message(payload){this.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify(payload)}));}
      close(code=1000,reason='fixture_closed'){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code,reason,wasClean:true}));}
    }
    page.context.WebSocket=HeldJoinSocket;
    const mounted=await page.mountApp();
    try {
      if(mounted.app.tutorialActive.value)await mounted.app.skipTutorial();
      mounted.app.roomIdInput.value='123456'; const joining=mounted.app.handleJoinRoom();
      for(let i=0;i<100&&!sockets.at(-1)?.sent.some(item=>item.type==='join_room');i+=1)await new Promise(resolve=>setTimeout(resolve,1));
      const socket=sockets.at(-1); assert.ok(socket?.sent.some(item=>item.type==='join_room'));
      await mounted.app.handleLeaveRoom(); await joining;
      socket.message(versionedRoomSnapshot('ROOM_JOINED'));await drainAppEvents();
      assert.equal(mounted.app.roomStatus.value,'solo');assert.equal(mounted.app.session.value.roomId,null);
      assert.equal(mounted.app.networkBusy.value,false);
    } finally {page.unmount(mounted.vueApp);page.cleanup();}
  });
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
      assert.equal(decodeSaved(page.local).match.started,true,'saved confirmed history remains playable after restart');
      assert.equal(decodeSaved(page.local).match.players.BLACK.choice,'human');
      assert.equal(decodeSaved(page.local).match.players.WHITE.choice,'human');
      assert.deepEqual(decodeSaved(page.local).actions,confirmedActions.map(({type,point})=>({type,point})),
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
      const saved=decodeSaved(page.local);
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
      assert.deepEqual(decodeSaved(page.local).actions,confirmedActions.map(({type,point})=>({type,point})),
        'the successful retry saves both confirmed moves');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
  });
  await check(platform,'capacity recovery rejects failed local save before leave',async()=>{
    const actions=[{type:'player_move',playerId:'alice',color:'BLACK',point:[1,0],actionSeq:1,matchEpoch:'epoch-session-integration',clientActionId:'a1'},
      {type:'player_move',playerId:'bob',color:'WHITE',point:[2,0],actionSeq:2,matchEpoch:'epoch-session-integration',clientActionId:'a2'}];
    const {page,mounted,socket}=await createVersionedRoom(platform,{initialActions:actions});
    try {
      const marker={serverInstanceId:'server-session-integration',roomInstanceId:'room-session-integration',matchGeneration:1,
        matchEpoch:'epoch-session-integration',blocked:true,count:1,serializedBytes:10,maxEntries:1,maxSerializedBytes:1024};
      const send=socket.send.bind(socket);socket.send=text=>{send(text);const request=JSON.parse(text);
        if(request.type==='sync_state')queueMicrotask(()=>socket.message({...versionedRoomSnapshot('SYNC_STATE',{
          actionSeq:2,roomRevision:4,syncRequestId:request.syncRequestId,matchState:{settings:{...roomSettings},actions:structuredClone(actions)}}),
          outcomeLedgerComplete:true,pendingActionOutcomes:[],actionOutcomeCapacity:marker}));};
      mounted.controller._onlineActionRecoveryListener({reason:'save_failure_test'});await drainAppEvents();
      assert.equal(mounted.controller._onlineActionSync.getState().capacityRecoveryReady,true);
      const manager=mounted.controller.networkManager;let leaves=0;const leave=manager.leaveRoom.bind(manager);
      manager.leaveRoom=async(...args)=>{leaves+=1;return leave(...args)};
      page.failNextLocal();await mounted.app.handleLeaveRoom();
      assert.equal(leaves,0,'failed local write must precede and prevent the leave request');
      assert.equal(mounted.app.roomStatus.value,'inProgress');
      assert.equal(mounted.controller.engine.getSnapshot().positionRevision,2);
      assert.equal(mounted.controller._onlineActionSync.getState().capacityRecoveryReady,true);
      await mounted.app.handleLeaveRoom();await drainAppEvents();
      assert.equal(leaves,1);assert.equal(mounted.app.roomStatus.value,'solo');
      assert.deepEqual(decodeSaved(page.local).actions,actions.map(({type,point})=>({type,point})));
    } finally { page.unmount(mounted.vueApp);page.cleanup(); }
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
      assert.deepEqual(decodeSaved(page.local).actions,confirmedActions.map(({type,point})=>({type,point})),
        'logout saves the full confirmed room history locally');
    }finally{page.unmount(mounted.vueApp);page.cleanup();}
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
  await check(platform,'pending replay export has one owner and late completion after unmount is inert',async()=>{
    const page=await openPage(platform,{realVue:true,controlledWorkers:true});
    let releaseDigest; const gate = new Promise(resolve => { releaseDigest=resolve; });
    let digestStarted=false;
    page.context.crypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto),subtle:{digest(...args){digestStarted=true;return gate.then(()=>webcrypto.subtle.digest(...args));}}};
    const mounted=await page.mountApp();
    try {
      if(mounted.app.tutorialActive.value)await mounted.app.skipTutorial();
      assert.equal(mounted.controller._applyMove([1,0]).success,true);
      const pending=mounted.app.handleExportReplay();
      for(let i=0;i<100 && !digestStarted;i+=1) await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(digestStarted,true,'actual Web replay export reaches asynchronous hashing');
      assert.equal(mounted.app.replayBusy.value,true);
      mounted.app.actionFeedback.value='newer visible state'; mounted.app.replayError.value='newer replay state';
      page.unmount(mounted.vueApp);
      assert.equal(mounted.app.replayBusy.value,false,'unmount releases the pending Web export busy flag');
      releaseDigest(); await pending;
      assert.equal(mounted.app.actionFeedback.value,'newer visible state');
      assert.equal(mounted.app.replayError.value,'newer replay state');
      assert.equal(mounted.app.replayBusy.value,false);
    } finally { releaseDigest(); page.cleanup(); }
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
const result={schema:'lifeline-parent-envelope-entry-v1',time:new Date().toISOString(),status:checks.some(check=>check.status==='FAIL')?'FAIL':'PASS-SCOPED',scope:'Actual common Web App/controller and merged legacy protocol in a Vue VM with synthetic sockets, storage and timers; replay hash is delayed for ownership test. No native runtime, device or real network.',dist,source_hashes:before,source_hashes_stable:true,checks,diagnostics};
if (receiptPath) await writeFile(receiptPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));if(result.status==='FAIL')process.exitCode=1;
