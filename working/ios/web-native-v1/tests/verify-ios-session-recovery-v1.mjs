import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/ios-session-recovery.js',import.meta.url),'utf8');
const context=vm.createContext({console});
const mod=new vm.SourceTextModule(source,{context});
await mod.link(spec=> spec === '@capacitor/core' ? new vm.SyntheticModule(['registerPlugin'],function(){this.setExport('registerPlugin',()=>({}));},{context}) : new vm.SyntheticModule(['claimIOSDocument'],function(){this.setExport('claimIOSDocument',async()=>({pageEpoch:1,documentNonce:'nonce'}));},{context}));
await mod.evaluate();
const {createIOSSessionRecovery,assertNoRecoveryPending,showIOSSessionRecovery}=mod.namespace;
const ordinary='lifeline-local-game-session-v1', topology='lifeline-topology-local-game-session-v1';
const marker=key=>`lifeline-ios-recovery-pending:${key}`;
function store(seed={}) {const m=new Map(Object.entries(seed));return { m, getItem:k=>m.has(k)?m.get(k):null, setItem(k,v){m.set(k,v);},removeItem(k){m.delete(k);} };}
const storage=store({[ordinary]:'old-ordinary',[topology]:'old-topology'}); const calls=[];
let failure=true;
const plugin={getSessionRecoveryStatus:async()=>({ordinary:'blocked',topology:'ready'}),resolveSessionRecovery:async x=>{calls.push(x);return {durable:!failure};}};
const api=createIOSSessionRecovery({storage,plugin,documentLease:{pageEpoch:1,documentNonce:'nonce'}});
await assert.rejects(api.clear('ordinary',false));
assert.equal(storage.getItem(ordinary),'old-ordinary');
await assert.rejects(api.clear('ordinary',true));
assert.equal(storage.getItem(marker(ordinary)),'1');
assert.equal(storage.getItem('lifeline-ios-recovery-backup:'+ordinary),'old-ordinary');
assert.equal(storage.getItem(topology),'old-topology');
assert.throws(()=>assertNoRecoveryPending(storage));
assert.equal((await api.status()).ordinary,'blocked');
failure=false; await api.clear('ordinary',true);
assert.equal(storage.getItem(marker(ordinary)),null);
assert.equal(storage.getItem(topology),'old-topology');
assert.equal(calls[1].key,ordinary); assert.equal(calls[1].confirm,true); assert.equal(calls[1].documentLease.pageEpoch,1);
assertNoRecoveryPending(storage);
for(const failAt of ['marker','backup','clear','remove']) {
  const s=store({[topology]:'original-topology',[ordinary]:'untouched'});
  const originalSet=s.setItem, originalRemove=s.removeItem;
  s.setItem=function(k,v){if((failAt==='marker'&&k===marker(topology))||(failAt==='backup'&&k.includes('recovery-backup:'))||(failAt==='clear'&&k===topology)) throw Error('disk');originalSet.call(s,k,v);};
  s.removeItem=function(k){if(failAt==='remove') throw Error('disk');originalRemove.call(s,k);};
  const c=createIOSSessionRecovery({storage:s,documentLease:{pageEpoch:1,documentNonce:'nonce'},plugin:{getSessionRecoveryStatus:async()=>({ordinary:'ready',topology:'blocked'}),resolveSessionRecovery:async()=>({durable:true})}});
  await assert.rejects(c.clear('topology',true));
  assert.equal(s.getItem(ordinary),'untouched');
  if(failAt!=='marker') {assert.equal(s.getItem(marker(topology)),'1');assert.throws(()=>assertNoRecoveryPending(s));}
}
const elements=[]; const document={createElement(tag){const e={tag,style:{},setAttribute(){},append(x){(this.children??=[]).push(x);}}; elements.push(e);return e;},body:{replaceChildren(e){this.child=e;}}};
let confirms=0, reloads=0;
const uiStore=store({[topology]:'topology'});
assert.equal(await showIOSSessionRecovery({document,storage:uiStore,plugin:{getSessionRecoveryStatus:async()=>({ordinary:'ready',topology:'blocked'}),resolveSessionRecovery:async()=>({durable:true})},confirm:()=>{confirms++;return false;},location:{reload(){reloads++;}}}),true);
const buttons=elements.filter(e=>e.tag==='button'); assert.equal(buttons.length,2);
await buttons[1].onclick(); assert.equal(confirms,1); assert.equal(reloads,0); assert.equal(uiStore.getItem(topology),'topology');
console.log('iOS session recovery: PASS (mock interruptions, per-key isolation, explicit confirmation; native/device unverified)');
