import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as VueRuntime from 'vue';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'mobile/dist');
const receiptPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const runtimeSourceManifest = JSON.parse(await readFile(path.join(repo, 'mobile/config/aligned-runtime-manifest.json'), 'utf8'));
const version = runtimeSourceManifest.runtime_asset_version;
assert.match(version, /^[A-Za-z0-9._-]+$/, 'credential-app harness uses the declared runtime asset version');
const key = 'lifeline-local-game-session-v1';
const clearKey = 'lifeline-local-game-session-cleared-v1';
const sourceNames = ['OnlineApp.js','OnlineAppState.js','NetworkManager.js','LocalGameSession.js','GameController.js','GameEngine.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name,hash(await readFile(path.join(dist,name)))])));
sourceNames.push('CrossPlatformNetwork.js','SharedRoomClient.js','OnlineAppI18n.js','AIStateProtocol.js');
const before = await hashes();
const session = actions => JSON.stringify({format:'lifeline-local-session',schemaVersion:1,savedAt:1,settings:{playerCount:2,gridSize:9,startPlayer:'BLACK',rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,hintEnabled:true,hintMaxCount:3},actions,playContext:{aiMode:'none',aiDepth:3,aiStrategy:'minimax',aiModelVersion:'2026092201',aiSeed:null,aiDuelPaused:false,tutorialDismissed:true}});
const empty = session([]);
const moved = session([{type:'player_move',point:[1,0]}]);
const envelope = (revision,payload) => JSON.stringify({format:'lifeline-local-session-envelope',version:1,revision,state:payload===null?'cleared':'saved',...(payload===null?{}:{payload})});
const flushMicrotasks=async()=>{for(let index=0;index<8;index+=1)await Promise.resolve();};

async function openPage(platform,{local=null,native=null,auth=null,legacyCleared=false,realVue=false,controlledWorkers=false,appInfoProvider=()=>({version:'1.0',build:'1'})}={}) {
  const localValues = new Map(local===null?[]:[[key,local]]);
  if (legacyCleared) localValues.set(clearKey,'1');
  if (auth) localValues.set('triaxis-auth',JSON.stringify(auth));
  let nativeValue = native;
  let failLocal = false;
  let failNative = false;
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
    console,URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,Uint32Array,ArrayBuffer,Blob,Request,Response,Headers,
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
  const context=vm.createContext(sandbox);
  const modules=new Map();
  const uri=name=>pathToFileURL(path.join(dist,name)).href;
  async function load(url){
    // Keep the full URL including its query: distinct browser module URLs must not be silently merged by this test.
    if(!modules.has(url)){
      const isMain=fileURLToPath(url)===path.join(dist,'main.js');
      const source=isMain?'globalThis.__parentBootstrapReached = true;':await readFile(fileURLToPath(url),'utf8');
      modules.set(url,new vm.SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta,module){meta.url=module.identifier;},importModuleDynamically:async(specifier,referencing)=>evaluate(new URL(specifier,referencing.identifier).href)}));
    }
    return modules.get(url);
  }
  async function evaluate(url){const module=await load(url);if(module.status==='unlinked')await module.link((specifier,referencing)=>load(new URL(specifier,referencing.identifier).href));if(module.status==='linked')await module.evaluate();return module;}
  context.__LIFELINE_AUTH_BOOTSTRAP__ = auth ? JSON.parse(JSON.stringify(auth)) : {token:null,username:null};
  context.LifelinePlatform = { isNative:true, contributionStartsEnabled:false };
  context.__LIFELINE_MOBILE_APP__=true;
  const api=(await evaluate(uri('LocalGameSession.js')+'?v='+version)).namespace;
  return {
    context,api,calls,unmounts,workers,timers,webSockets,evaluate,uri,localValues,
    get local(){return localValues.get(key)??null;},get native(){return nativeValue;},get legacyClear(){return localValues.get(clearKey)??null;},
    failNextLocal(){failLocal=true;},failNextNative(){failNative=true;},
    flush:()=>context.LifelinePlatform.flushSessionMirror(),
    dispatchLifecycle(name){context.dispatchEvent(new Event(`lifeline:${name}`));},
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
      await Promise.resolve(app.handleControllerReady(controller));
      if(realVue) await VueRuntime.nextTick();
      const { serializeEngineState } = (await evaluate(uri('AIStateProtocol.js')+'?v='+version)).namespace;
      return {app,controller,GameEngine,ReplayPanel:App.components.ReplayPanel,vueApp,serializeEngineState};
    },
    runTimers(maxDelay=Infinity){let count=0;while(true){const entry=[...timers.entries()].find(([,timer])=>timer.delay<=maxDelay);if(!entry)break;const [id,timer]=entry;if(!timer.interval)timers.delete(id);timer.callback(...timer.args);count+=1;if(count>1000)throw new Error('controlled timer loop exceeded 1000 callbacks');}return count;},
    fireTimer(id){const timer=timers.get(id);if(!timer)return false;timers.delete(id);timer.callback(...timer.args);return true;},
    cleanup(){for(const callback of unmounts)callback();},
    unmount(vueApp){vueApp?.unmount();},
  };
}

// Independent App-level test: actual Vue watchers, App, NetworkManager, and
// game/session modules. Platform persistence is a controlled contract double.
// This does not exercise platform keystores, a native build, or a real display.
const fakeCredential = {token:'synthetic-parent-app-token',username:'parent_fixture'};
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const drain = async () => {for(let i=0;i<50;i++)await Promise.resolve();await VueRuntime.nextTick();};
async function appFixture({auth=null,save=async()=>true,clear=async()=>true,login=null,browser=false,leaveFails=false}={}) {
  const page=await openPage('android',{auth,realVue:true,controlledWorkers:true});
  page.context.localStorage.setItem('lifeline-tutorial-dismissed-v1','1');
  if(!browser)page.localValues.delete('triaxis-auth');
  let owner=1,manager=null;const persistence=[];
  page.context.LifelinePlatform={
    isNative:!browser,contributionStartsEnabled:false,getCredentialStorageState:()=>"ready",
    beginCredentialAttempt:()=>({owner:++owner}),
    isCredentialAttemptCurrent:attempt=>attempt?.owner===owner,
    async saveCredential(value){persistence.push('save');return await save(value);},
    async clearCredential(){owner++;persistence.push('clear');return await clear();},
  };
  page.context.fetch=async(url,options)=>{
    if(String(url).endsWith('/api/login')){
      assert.equal(JSON.parse(options.body).password,'synthetic-fixture-password');
      const result=login?await login():fakeCredential;
      return{ok:true,status:200,json:async()=>result};
    }
    return{ok:true,status:200,text:async()=>''};
  };
  // CrossPlatformNetwork imports this exact versioned module URL.
  const NM=(await page.evaluate(page.uri('NetworkManager.js')+'?v=20261101-platform-alignment-r1')).namespace.NetworkManager;
  const set=NM.prototype.setAuthToken;NM.prototype.setAuthToken=function(value){manager=this;return set.call(this,value);};
  if(leaveFails)NM.prototype.leaveRoom=async function(){throw Error('Synthetic leave failure');};
  const mounted=await page.mountApp(!browser);await drain();
  const submit=()=>{mounted.app.authUsername.value=fakeCredential.username;mounted.app.authPassword.value='synthetic-fixture-password';return mounted.app.handleAuthSubmit();};
  return{page,mounted,submit,persistence,get manager(){return manager;},close(){page.unmount(mounted.vueApp);}};
}
const checks=[];
async function check(name,run){try{await run();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:String(error?.message??error).replaceAll(fakeCredential.token,'[synthetic]').slice(0,1000)});}}
await check('native restored auth survives immediate watcher without another save',async()=>{
  const f=await appFixture({auth:fakeCredential});try{assert.equal(f.mounted.app.isAuthenticated.value,true);assert.equal(f.manager.authToken,fakeCredential.token);assert.deepEqual(f.persistence,[]);assert.equal(f.page.localValues.has('triaxis-auth'),false);}finally{f.close();}
});
await check('mobile persistAuth does not mirror the token or trigger a second native save',async()=>{
  const f=await appFixture({auth:fakeCredential});try{
    const state=(await f.page.evaluate(f.page.uri('OnlineAppState.js')+'?v='+version)).namespace;
    state.persistAuth(fakeCredential);
    assert.equal(f.page.localValues.has('triaxis-auth'),false);
    assert.deepEqual(f.persistence,[]);
  }finally{f.close();}
});
await check('new native login waits for storage acknowledgment',async()=>{
  const held=deferred();const f=await appFixture({save:()=>held.promise});try{const submitting=f.submit();await drain();assert.deepEqual(f.persistence,['save']);assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);held.resolve(true);await submitting;await drain();assert.equal(f.mounted.app.isAuthenticated.value,true);assert.equal(f.manager.authToken,fakeCredential.token);assert.equal(f.page.localValues.has('triaxis-auth'),false);assert.equal(f.mounted.app.authPassword.value,'');}finally{held.resolve(true);f.close();}
});
await check('failed native persistence leaves login and singleplayer save unchanged',async()=>{
  const f=await appFixture({save:async()=>false});try{const local=f.page.local;await f.submit();await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);assert.ok(f.mounted.app.authError.value);assert.equal(f.page.local,local);assert.equal(f.page.localValues.has('triaxis-auth'),false);}finally{f.close();}
});
await check('login response arriving after logout cannot save or restore auth',async()=>{
  const held=deferred();const f=await appFixture({login:()=>held.promise});try{const submitting=f.submit();await drain();await f.mounted.app.handleLogout();held.resolve(fakeCredential);await submitting;await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);assert.deepEqual(f.persistence,['clear']);}finally{held.resolve(fakeCredential);f.close();}
});
await check('late successful save after logout cannot publish auth',async()=>{
  const held=deferred();const f=await appFixture({save:()=>held.promise});try{const submitting=f.submit();await drain();await f.mounted.app.handleLogout();held.resolve(true);await submitting;await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);}finally{held.resolve(true);f.close();}
});
await check('failed room leave still clears auth and disconnects locally',async()=>{
  const f=await appFixture({auth:fakeCredential,leaveFails:true});try{f.mounted.app.roomStatus.value='inProgress';await f.mounted.app.handleLogout();await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);assert.equal(f.manager.url,null);assert.equal(f.manager.roomId,null);assert.deepEqual(f.persistence,['clear']);assert.ok(f.mounted.app.networkError.value);}finally{f.close();}
});
await check('unconfirmed native clear removes memory auth and reports failure',async()=>{
  const f=await appFixture({auth:fakeCredential,clear:async()=>false});try{await f.mounted.app.handleLogout();await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.equal(f.manager.authToken,null);assert.equal(f.manager.url,null);assert.ok(f.mounted.app.authError.value);}finally{f.close();}
});
await check('ordinary browser login retains existing persistence behavior',async()=>{
  const f=await appFixture({browser:true});try{await f.submit();await drain();assert.equal(f.mounted.app.isAuthenticated.value,true);assert.deepEqual(JSON.parse(f.page.localValues.get('triaxis-auth')),{...fakeCredential,authOrigin:'http://synthetic-mobile-review.localhost'});assert.deepEqual(f.persistence,[]);}finally{f.close();}
});

await check('unmounted App rejects a late server login before persistence',async()=>{
  const held=deferred();const f=await appFixture({login:()=>held.promise});const submitting=f.submit();await drain();f.close();held.resolve(fakeCredential);await submitting;await drain();assert.equal(f.persistence.includes('save'),false);assert.equal(f.mounted.app.isAuthenticated.value,false);
});
await check('an in-flight login blocks another until a safe retry',async()=>{
  const old=deferred();let calls=0;const f=await appFixture({login:()=>++calls===1?old.promise:fakeCredential});try{const first=f.submit();await drain();await f.submit();assert.equal(calls,1);old.reject(Error('Synthetic server failure'));await first;await drain();await f.submit();await drain();assert.equal(f.mounted.app.isAuthenticated.value,true);assert.equal(f.mounted.app.authError.value,'');}finally{old.resolve(fakeCredential);f.close();}
});
await check('unavailable credential authority gives visible login failure',async()=>{
  const f=await appFixture();try{f.page.context.LifelinePlatform.isCredentialAttemptCurrent=()=>false;await f.submit();await drain();assert.equal(f.mounted.app.isAuthenticated.value,false);assert.ok(f.mounted.app.authError.value);}finally{f.close();}
});


await check('explicit retry recovers storage before server login',async()=>{
  const calls=[];const f=await appFixture({login:async()=>{calls.push('server');return fakeCredential;}});try{f.page.context.LifelinePlatform.getCredentialStorageState=()=> 'unknown';f.page.context.LifelinePlatform.retryCredentialStorage=async()=>{calls.push('retry');return{state:'ready'};};await f.submit();await drain();assert.deepEqual(calls,['retry','server']);assert.equal(f.mounted.app.isAuthenticated.value,true);}finally{f.close();}
});
await check('logout during storage recovery prevents any later server login',async()=>{
  let logins=0;const held=deferred();const f=await appFixture({login:async()=>{logins++;return fakeCredential;}});try{f.page.context.LifelinePlatform.getCredentialStorageState=()=> 'unknown';f.page.context.LifelinePlatform.retryCredentialStorage=()=>held.promise;const pending=f.submit();await drain();await f.mounted.app.handleLogout();held.resolve({state:'ready'});await pending;await drain();assert.equal(logins,0);assert.equal(f.mounted.app.isAuthenticated.value,false);}finally{held.resolve({state:'ready'});f.close();}
});
await check('failed storage recovery is visible and does not contact login server',async()=>{
  let logins=0;const f=await appFixture({login:async()=>{logins++;return fakeCredential;}});try{f.page.context.LifelinePlatform.getCredentialStorageState=()=> 'unknown';f.page.context.LifelinePlatform.retryCredentialStorage=async()=>({state:'error'});await f.submit();await drain();assert.equal(logins,0);assert.ok(f.mounted.app.authError.value);assert.equal(f.mounted.app.isAuthenticated.value,false);}finally{f.close();}
});

const after=await hashes();
const result={scope:'Actual App/Vue/NetworkManager modules with controlled platform and server APIs; native/browser-render acceptance not performed',sourceBefore:before,sourceAfter:after,sourceStable:JSON.stringify(before)===JSON.stringify(after),checks,passed:checks.filter(x=>x.pass).length,total:checks.length};
if(receiptPath)await writeFile(receiptPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:result.passed,total:result.total,sourceStable:result.sourceStable,failures:checks.filter(x=>!x.pass)}));
if(!result.sourceStable||result.passed!==result.total)process.exitCode=1;
