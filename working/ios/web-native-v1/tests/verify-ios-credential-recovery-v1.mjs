import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../src/ios-credential-recovery.js',import.meta.url),'utf8');
const context=vm.createContext({}); const mod=new vm.SourceTextModule(source,{context}); await mod.link(()=>{}); await mod.evaluate();
const {createIOSCredentialRecovery}=mod.namespace;
function fixture({accept=true,clearResult=true,retryState='ready'}={}) {
  const elements=[]; let clearCount=0,retryCount=0;
  const document={body:{append(e){this.child=e;}},createElement(tag){const e={tag,style:{},children:[],setAttribute(){},append(x){this.children.push(x);},remove(){this.removed=true;}};elements.push(e);return e;}};
  const authority={clear:async()=>{clearCount++;return clearResult;},retry:async()=>{retryCount++;return {state:retryState};}};
  const ui=createIOSCredentialRecovery({document,confirm:()=>accept,getAuthority:()=>authority,language:'en'});
  return {ui,elements,counts:()=>({clearCount,retryCount})};
}
for(const accepted of [false,true]) {
  const f=fixture({accept:accepted}); f.ui.update({state:'error'}); const buttons=f.elements.filter(e=>e.tag==='button');
  await buttons[1].onclick();
  assert.equal(f.counts().clearCount,accepted?1:0); assert.equal(f.counts().retryCount,accepted?1:0);
}
const failed=fixture({clearResult:false}); failed.ui.update({state:'unknown'}); await failed.elements.filter(e=>e.tag==='button')[1].onclick();
assert.equal(failed.counts().retryCount,0); assert.match(failed.elements.find(e=>e.tag==='aside').children[1].textContent,/could not be confirmed/);
const retry=fixture(); retry.ui.update({state:'error'}); await retry.elements.filter(e=>e.tag==='button')[0].onclick();
assert.equal(retry.counts().clearCount,0); assert.equal(retry.counts().retryCount,1); retry.ui.update({state:'ready'}); assert.equal(retry.elements.find(e=>e.tag==='aside').removed,true);
console.log('iOS credential recovery: PASS (mock retry, confirmation, failure and success; native/device unverified)');
const integrationContext=vm.createContext({setTimeout,clearTimeout});
const authoritySource=await readFile(new URL('../../../platform-hosts/mobile/src/credential-authority.js',import.meta.url),'utf8');
const authorityModule=new vm.SourceTextModule(authoritySource,{context:integrationContext}); await authorityModule.link(()=>{}); await authorityModule.evaluate();
const uiModule=new vm.SourceTextModule(source,{context:integrationContext}); await uiModule.link(()=>{}); await uiModule.evaluate();
const map=new Map(); const store={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
let pending=true, generation=0; const provider={claim:async()=>({pageEpoch:1,ownerGeneration:++generation,documentNonce:'nonce'}),load:async()=>{if(pending) throw Error('pending');return {state:'cleared'};},clear:async()=>{pending=false;return {durable:true};}};
const integrationElements=[]; const document={body:{append(e){this.child=e;}},createElement(tag){const e={tag,style:{},children:[],setAttribute(){},append(x){this.children.push(x);},remove(){this.removed=true;}};integrationElements.push(e);return e;}};
let authority; const ui=uiModule.namespace.createIOSCredentialRecovery({document,confirm:()=>true,getAuthority:()=>authority,language:'en'});
authority=authorityModule.namespace.createCredentialAuthority({provider,storage:store,onStatus:status=>ui.update(status)});
assert.equal((await authority.bootstrap()).state,'error');
await integrationElements.filter(e=>e.tag==='button')[1].onclick();
assert.equal(authority.getState(),'ready'); assert.equal(pending,false); assert.equal(map.has('lifeline-auth-clear-pending-v1'),false);
console.log('iOS credential authority pending recovery: PASS (actual shared authority with mocked native provider)');
