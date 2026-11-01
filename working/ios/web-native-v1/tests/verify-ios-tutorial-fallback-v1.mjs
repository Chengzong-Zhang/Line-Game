import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/ios-bridge.js',import.meta.url),'utf8');
let claimCalls=0, nativeCalls=0, authorityNative='unset';
const context=vm.createContext({localStorage:{},CustomEvent:class{},dispatchEvent(){},addEventListener(){},setTimeout,clearTimeout});
const modules={
 '@capacitor/core':{Capacitor:{isNativePlatform:()=>false},registerPlugin:()=>new Proxy({}, {get(){nativeCalls++;throw Error('unexpected native plugin call');}})},
 './capability-contract.js':{createCapabilities:x=>x,queryCapabilities:()=>{}},
 './replay-import-client.js':{createReplayImportClient:()=>{}},
 './session-authority.js':{initializeSessionAuthority:async({native})=>{authorityNative=native;return {};}},
 './network-status.js':{createNetworkStatusController:()=>{}},
 './credential-authority.js':{createCredentialAuthority:()=>{}},
 './ios-credential-recovery.js':{createIOSCredentialRecovery:()=>{}},
 './ios-document-lease.js':{claimIOSDocument:()=>{claimCalls++;throw Error('unexpected claim');}},
 './ios-polling.js':{startIOSLifecyclePolling:()=>{},createIOSNetworkPolling:()=>{}},
};
const mod=new vm.SourceTextModule(source,{context}); await mod.link(spec=>{const dep=modules[spec];assert.ok(dep,spec);return new vm.SyntheticModule(Object.keys(dep),function(){for(const [k,v] of Object.entries(dep))this.setExport(k,v);},{context});});await mod.evaluate();
await mod.namespace.initializePlatform();
assert.equal(authorityNative,null); assert.equal(claimCalls,0);assert.equal(nativeCalls,0);assert.equal(context.LifelinePlatform.isNative,false);
assert.equal((await context.LifelinePlatform.getCapabilities()).platform,'browser');
console.log('iOS isolated tutorial fallback: PASS (mock non-native bridge; WKWebView/device unverified)');
