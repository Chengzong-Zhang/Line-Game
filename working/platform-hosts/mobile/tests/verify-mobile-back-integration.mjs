import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as VueRuntime from 'vue';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'mobile/dist');
const version = '20261013-full-features1';
const key = 'lifeline-local-game-session-v1';
const topologyKey = 'lifeline-topology-local-game-session-v1';
const clearKey = 'lifeline-local-game-session-cleared-v1';
const session = actions => JSON.stringify({format:'lifeline-local-session',schemaVersion:1,savedAt:1,settings:{playerCount:2,gridSize:9,startPlayer:'BLACK',rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,hintEnabled:true,hintMaxCount:3},actions,playContext:{aiMode:'none',aiDepth:3,aiStrategy:'minimax',aiModelVersion:'2026092201',aiSeed:null,aiDuelPaused:false,tutorialDismissed:true}});
const empty = session([]);
const envelope = (revision,payload) => JSON.stringify({format:'lifeline-local-session-envelope',version:1,revision,state:payload===null?'cleared':'saved',...(payload===null?{}:{payload})});
const flushMicrotasks=async()=>{for(let index=0;index<8;index+=1)await Promise.resolve();};

async function openPage(platform,{local=null,native=null,auth=null,legacyCleared=false,realVue=false,controlledWorkers=false,currentOnlineApp=false,appInfoProvider=()=>({version:'1.0',build:'1'})}={}) {
  const localValues = new Map(local===null?[]:[[key,local]]);
  if (legacyCleared) localValues.set(clearKey,'1');
  if (auth) localValues.set('triaxis-auth',JSON.stringify(auth));
  let nativeValue = native;
  let nativeTopologyValue = null;
  let nativeCredentialState = 'missing';
  let nativeCredential = null;
  let credentialOwnerGeneration = 0;
  const nativeDocumentNonce = 'synthetic-native-document-nonce';
  let failLocal = false;
  let failNative = false;
  let pausedNative = null;
  let appStateListener = null;
  let nativeBackListener = null;
  let nativeBackEventCaptured = false;
  let minimizeCalls = 0;
  const calls = [];
  const events = new EventTarget();
  events.addEventListener('capacitor:minimizeApp', () => { minimizeCalls += 1; });
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
    assert.ok([key, topologyKey].includes(passedKey));
    calls.push({operation,value});
    if(operation==='loadRecord')return {value:passedKey === key ? nativeValue : nativeTopologyValue};
    if(operation==='saveRecord'){
      if(pausedNative){const paused=pausedNative;pausedNative=null;paused.started();await paused.hold;}
      if(failNative){failNative=false;throw new Error('Synthetic native write failure');}
      if (passedKey === key) nativeValue=value; else nativeTopologyValue=value;
      return platform==='android'?{durable:true}:{flushed:true};
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
      {name:'App',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'promise'},{name:'getState',rtype:'promise'},{name:'getInfo',rtype:'promise'},{name:'minimizeApp',rtype:'promise'}]},
    ],nativePromise(plugin,method,args){if(plugin==='LifelineStorage')return nativeOperation(method,args.key,args.value,args);if(plugin==='App'&&method==='getState')return Promise.resolve({isActive:true});if(plugin==='App'&&method==='getInfo')return nativeOperation('getAppInfo','', '');if(plugin==='App'&&method==='minimizeApp'){events.dispatchEvent(new Event('capacitor:minimizeApp'));return Promise.resolve();}throw new Error(`Unexpected plugin ${plugin}`);},nativeCallback(plugin,method,args,callback){if(plugin==='App'&&method==='addListener'){if(args.eventName==='appStateChange')appStateListener=callback;else if(args.eventName==='backButton'){nativeBackListener=callback;if(!nativeBackEventCaptured){nativeBackEventCaptured=true;events.addEventListener('capacitor:backButton',event=>callback(event.detail));}}}return Promise.resolve({callbackId:'synthetic-lifecycle'});}};
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
    get nativeBackListener(){return nativeBackListener;}, get minimizeCalls(){return minimizeCalls;},
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
      app.handleControllerReady(controller);
      return {app,controller,GameEngine,ReplayPanel:App.components.ReplayPanel,vueApp};
    },
    runTimers(maxDelay=Infinity){let count=0;while(true){const entry=[...timers.entries()].find(([,timer])=>timer.delay<=maxDelay);if(!entry)break;const [id,timer]=entry;if(!timer.interval)timers.delete(id);timer.callback(...timer.args);count+=1;if(count>1000)throw new Error('controlled timer loop exceeded 1000 callbacks');}return count;},
    fireTimer(id){const timer=timers.get(id);if(!timer)return false;timers.delete(id);timer.callback(...timer.args);return true;},
    cleanup(){for(const callback of unmounts)callback();},
    unmount(vueApp){vueApp?.unmount();},
  };
}

const page = await openPage('android', { realVue: true, controlledWorkers: true, currentOnlineApp: true });
let mounted;
let vueMounted = false;

const backObservations = [];
try {
  mounted = await page.mountApp(true);
  const { app, controller, vueApp } = mounted;
  vueMounted = true;
  assert.ok(vueApp, 'the production OnlineApp component is mounted through the real Vue renderer');

  let moveToBackgroundCalls = 0;
  page.context.LifelinePlatform = Object.freeze({
    ...page.context.LifelinePlatform,
    moveToBackground: async () => { moveToBackgroundCalls += 1; },
  });
  page.context.addEventListener('lifeline:back', event => {
    backObservations.push({ cancelable: event.cancelable, defaultPrevented: event.defaultPrevented });
  });

  page.context.CapacitorCustomPlatform = { name: 'android' };
  const bootstrapSource = await readFile(path.join(dist, 'platform/native-back-bootstrap.js'), 'utf8');
  const bootstrap = new vm.SourceTextModule(bootstrapSource, { context: page.context, identifier: 'file:///integration/generated-native-back-bootstrap.js' });
  await bootstrap.link(() => { throw new Error('The generated native back bundle must be self-contained.'); });
  await bootstrap.evaluate();
  await flushMicrotasks();
  assert.equal(typeof page.nativeBackListener, 'function', 'generated bootstrap registers the Capacitor back callback');

  const originalController = app.controller.value;
  app.roomStatus.value = 'inProgress';
  app.session.value = { ...app.session.value, roomId: 'BACK-ROOM-42', roomCode: 'BACK-ROOM-42', roomStatus: 'inProgress', playerId: 'player-local', players: [{ playerId: 'player-local', name: 'Local' }, { playerId: 'player-remote', name: 'Remote' }] };
  controller.multiplayerEnabled = true;
  controller.roomReady = true;
  controller.opponentConnected = true;
  controller.networkManager = { roomId: 'BACK-ROOM-42' };
  const originalSession = JSON.parse(JSON.stringify(app.session.value));
  let originalGameState;
  const dispatchNativeBack = async () => {
    page.context.dispatchEvent(new CustomEvent('capacitor:backButton',{detail:{canGoBack:false}}));
    await flushMicrotasks();
  };

  await app.handleOpenUtilityDeck('board');
  originalGameState = JSON.parse(JSON.stringify(app.gameState.value));
  assert.equal(app.activeUtilityDeck.value, 'board', 'the real OnlineApp opens a utility panel');
  await dispatchNativeBack();
  assert.equal(app.activeUtilityDeck.value, '', 'native back closes the open utility panel');
  assert.deepEqual(backObservations.at(-1), { cancelable: true, defaultPrevented: true }, 'OnlineApp cancels the native back event after handling the panel');
  assert.equal(app.controller.value, originalController, 'closing the panel preserves the controller');
  assert.equal(JSON.stringify(app.session.value), JSON.stringify(originalSession), 'closing the panel preserves the session and room state');
  assert.equal(JSON.stringify(app.gameState.value), JSON.stringify(originalGameState), 'closing the panel preserves the deep game-state snapshot');
  assert.equal(app.gameState.value.positionRevision, originalGameState.positionRevision, 'closing the panel preserves the game position revision');
  assert.equal(app.gameState.value.currentPlayer, originalGameState.currentPlayer, 'closing the panel preserves the acting player');
  assert.equal(app.session.value.roomId, 'BACK-ROOM-42', 'fixture represents a non-empty online room');
  assert.equal(moveToBackgroundCalls, 0, 'closing a panel does not request a background transition');
  assert.equal(page.minimizeCalls, 0, 'handled back does not fall through to native minimize');

  app.handleOpenGuideEntry('rules');
  assert.equal(app.activeGuideEntry.value?.key, 'rules', 'the real Guide entry is open');
  await dispatchNativeBack();
  assert.equal(app.activeGuideEntry.value, null, 'native back closes a Guide entry before requesting app exit');
  assert.equal(app.mobileExitPromptOpen.value, false, 'closing a Guide entry does not also open the exit prompt');
  assert.equal(backObservations.at(-1).defaultPrevented, true, 'Guide back handling cancels the native event');

  app.roomStatus.value = 'solo';
  app.networkBusy.value = false;
  app.tutorialActive.value = false;
  controller.multiplayerEnabled = false;
  controller.roomReady = false;
  controller.opponentConnected = false;
  controller.networkManager = null;
  controller.restoreMatchState = () => ({ success: true, state: JSON.parse(JSON.stringify(originalGameState)) });
  controller.setReadOnlyMode = () => {};
  const replayMove = controller.engine.getLegalMoves()[0];
  assert.ok(replayMove, 'fixture engine provides a legal move for a real replay');
  app.localGameActions.value = [{ type: 'move', player: 'BLACK', point: replayMove.point }];
  await app.handleStartReplay('current');
  assert.equal(app.replayMode.value, true, 'real replay entry succeeds: ' + app.replayError.value);
  app.replayInspectorOpen.value = true;
  await dispatchNativeBack();
  assert.equal(app.replayInspectorOpen.value, false, 'native back closes the replay inspector first');
  assert.equal(app.mobileExitPromptOpen.value, false, 'closing the replay inspector does not also open the exit prompt');
  assert.equal(backObservations.at(-1).defaultPrevented, true, 'replay inspector back handling cancels the native event');
  app.handleExitReplay();
  assert.equal(app.replayMode.value, false, 'the replay exits before checking the root confirmation');

  await dispatchNativeBack();
  assert.equal(app.mobileExitPromptOpen.value, true, 'native back with no higher-priority panel opens the exit confirmation');
  assert.equal(app.mobileExitPending.value, false, 'showing the exit confirmation does not begin the exit operation');
  assert.equal(moveToBackgroundCalls, 0, 'showing the confirmation alone does not move the app to background');
  assert.equal(page.minimizeCalls, 0, 'the handled root back does not fall through to native minimize');
  assert.equal(app.controller.value, originalController, 'opening the confirmation preserves the controller');
  assert.equal(JSON.stringify(app.session.value), JSON.stringify(originalSession), 'opening the confirmation preserves the current session and room');
  assert.deepEqual(backObservations, Array.from({ length: 4 }, () => ({ cancelable: true, defaultPrevented: true })),
    'all native callbacks dispatch cancelable events that the mounted app consumes');
} finally {
  if (vueMounted) page.unmount(mounted.vueApp);
  page.cleanup();
}

console.log(`Mobile back integration: ${backObservations.length} cancelable events; mounted OnlineApp VM and Capacitor bootstrap path verified (host evidence only).`);





