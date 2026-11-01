import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/ios-bridge.js', import.meta.url), 'utf8');
const calls = []; const listeners = {}; let stateResolve;
const plugins = {
  LifelineIOS: {
    getAppState: async ({documentLease}) => { assert.equal(documentLease.pageEpoch,1); return {isActive:false}; },
    getAppInfo: async () => ({ version: '1.2', build: '3' }),
    shareReplay: async value => { calls.push(['share', value]); return {status:'returned'}; },
  },
  LifelineStorage: {
    loadRecord: async ({documentLease}) => { assert.equal(documentLease.pageEpoch,1); return {state:'missing'}; }, saveRecord: async () => ({durable:true}),
    claimCredentialOwner: async value => { calls.push(['claim', value]); return {}; },
    loadCredential: async () => ({state:'missing'}),
  },
  LifelineCapabilities: { getCapabilities: async () => ({}) },
  LifelineNetwork: { startNetworkStatus: async value => {calls.push(['network-start',value]);}, stopNetworkStatus: async value => {calls.push(['network-stop',value]);} }, LifelineReplayImport: { selectReplay: async value => {calls.push(['import',value]); return {status:'cancelled'};} },
  LifelineHaptics: { requestMoveHaptic: async value => {calls.push(['haptic',value]); return {};} },
  LifelineTutorialHost: { openTutorial: async value => {calls.push(['tutorial',value]);return {status:'opened'};} },
};
const events = new EventTarget();
const context = vm.createContext({ console, TextEncoder, Uint32Array, crypto:webcrypto, setTimeout, clearTimeout, localStorage:{},
  document: {}, confirm: () => false, navigator: {language:'en'},
  CustomEvent: class extends Event { constructor(type, options={}) { super(type); this.detail=options.detail; } },
  addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  __LIFELINE_DOCUMENT_CHALLENGE__: 'x'.repeat(64),
});
const dependencies = {
  '@capacitor/core': { Capacitor: {isNativePlatform:()=>true,getPlatform:()=> 'ios'}, registerPlugin: name => plugins[name] },
  './capability-contract.js': { createCapabilities:()=>({}), queryCapabilities: async options => ({platform:options.platform,source:options.source}) },
  './replay-import-client.js': { createReplayImportClient: ({select}) => ({importReplay:select}) },
  './session-authority.js': { initializeSessionAuthority: async ({native}) => { await native.load(); return {flushSessionMirror:async()=>{}}; } },
  './ios-polling.js': {startIOSLifecyclePolling:async ({read,publish})=>publish((await read()).isActive),createIOSNetworkPolling:()=>async()=>({remove:async()=>{}})},
  './ios-document-lease.js': {claimIOSDocument: async () => ({pageEpoch:1,documentNonce:'nonce'})},
  './ios-credential-recovery.js': {createIOSCredentialRecovery: () => ({update(){}})},
  './credential-authority.js': { createCredentialAuthority: ({provider}) => ({bootstrap:async()=>provider.claim({expectedOwnerGeneration:-1}), save(){},clear(){},beginAttempt(){},isAttemptCurrent(){},retry(){},getState(){}}) },
  './network-status.js': { createNetworkStatusController: ({source,startNative,stopNative}) => ({getStatus:async()=>({source}),subscribe:()=>{void startNative('token');return ()=>{void stopNative('token');};}}) },
};
const mod = new vm.SourceTextModule(source,{context});
await mod.link(spec => { const dep=dependencies[spec]; assert.ok(dep, spec); return new vm.SyntheticModule(Object.keys(dep),function(){for(const [k,v] of Object.entries(dep)) this.setExport(k,v);},{context}); });
await mod.evaluate();
const init = mod.namespace.initializePlatform();
await init;
assert.equal(context.__LIFELINE_APP_ACTIVE__,false);
const api=context.LifelinePlatform;
assert.equal((await api.getCapabilities()).platform,'ios');
assert.equal((await api.getNetworkStatus()).source,'ios-native');
assert.equal((await api.getAppInfo()).build,'3');
assert.equal((await api.shareReplay({format:'lifeline-replay',schemaVersion:1})).status,'returned');
assert.equal(calls.find(([name])=>name==='share')[1].replayDocument.format,'lifeline-replay');
await assert.rejects(api.shareReplay({format:'wrong',schemaVersion:1}));
await assert.rejects(api.shareReplay({format:'lifeline-replay',schemaVersion:1,payload:'x'.repeat(4_000_000)}));
assert.equal(calls.filter(([name])=>name==='share').length,1);
await api.importReplay(); await api.requestMoveHaptic(); await api.openTutorial('capacitor://localhost/index.html?tutorial=1');
const unsubscribe=api.subscribeNetworkStatus(()=>{}); unsubscribe();
for (const kind of ['share','import','haptic','tutorial','network-start','network-stop']) {
  assert.equal(calls.find(([name])=>name===kind)[1].documentLease.pageEpoch,1,`${kind} is document-bound`);
}
assert.equal(api.moveToBackground,undefined);
console.log('iOS JS adapter: PASS (mocked plugins; no Swift or device validation)');
