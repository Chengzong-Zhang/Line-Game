import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root=fileURLToPath(new URL('../../', import.meta.url));
const file='mobile/harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets';
const source=await readFile(path.join(root,file),'utf8');
const output=process.argv[2];
const registryFile='mobile/harmony/entry/src/main/ets/bridge/WebControllerRegistry.ets';
const registrySource=await readFile(path.join(root,registryFile),'utf8');
const transpiled=ts.transpileModule(source.replace(/^import .*;\r?\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<160;i++)await Promise.resolve();};
const CIPHER='lifeline-credential-ciphertext-v1',BARRIER='lifeline-credential-barrier-v1';
const credential={token:'synthetic-parent-huks-token',username:'测试😀'};
function harness({realRegistry=false}={}){
  const keys=new Map(),handles=new Map(),values=new Map(),pending=new Map(),calls=[],logs=[];
  let scriptGate=null,currentUrl='https://lifeline.appassets.invalid/index.html';
  let owner=1,sequence=0,handleId=0,hookGet=null,hookFinish=null,hookFlush=null,keyQueryFails=false,finishFails=false;
  const T={HUKS_TAG_ALGORITHM:1,HUKS_TAG_KEY_SIZE:2,HUKS_TAG_PURPOSE:3,HUKS_TAG_PADDING:4,HUKS_TAG_BLOCK_MODE:5,HUKS_TAG_NONCE:6,HUKS_TAG_ASSOCIATED_DATA:7,HUKS_TAG_AE_TAG:8};
  const prop=(options,tag)=>options.properties?.find(p=>p.tag===tag)?.value;
  const huks={HuksTag:T,HuksKeyAlg:{HUKS_ALG_AES:10},HuksKeySize:{HUKS_AES_KEY_SIZE_128:128,HUKS_AES_KEY_SIZE_256:256},HuksKeyPurpose:{HUKS_KEY_PURPOSE_ENCRYPT:1,HUKS_KEY_PURPOSE_DECRYPT:2},HuksKeyPadding:{HUKS_PADDING_NONE:0},HuksCipherMode:{HUKS_MODE_GCM:9},
    async isKeyItemExist(alias){calls.push({op:'key-exists'});if(keyQueryFails)throw Error('synthetic-secret-provider-query-detail');return keys.has(alias);},
    async getKeyItemProperties(alias){calls.push({op:'key-properties'});if(keyQueryFails||!keys.has(alias))throw Error('synthetic-secret-provider-query-detail');return{properties:[]};},
    async generateKeyItem(alias,options){calls.push({op:'key-generate'});if(keys.has(alias))throw Error('Existing key');const bits=prop(options,T.HUKS_TAG_KEY_SIZE);assert.equal(bits,256);keys.set(alias,randomBytes(bits/8));return{};},
    async initSession(alias,options){calls.push({op:'init'});assert.ok(keys.has(alias),'decryption cannot generate a replacement key');const handle=++handleId;handles.set(handle,{alias,options});return{handle};},
    async finishSession(handle,options){calls.push({op:'finish'});if(hookFinish)await hookFinish();if(finishFails)throw Error('synthetic-secret-provider-finish-detail');const entry=handles.get(handle);assert.ok(entry);const props=entry.options,key=keys.get(entry.alias),nonce=Buffer.from(prop(props,T.HUKS_TAG_NONCE)),aad=Buffer.from(prop(props,T.HUKS_TAG_ASSOCIATED_DATA));assert.equal(nonce.length,12);let out;
      if(prop(props,T.HUKS_TAG_PURPOSE)===1){const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);out=Buffer.concat([cipher.update(options.inData),cipher.final(),cipher.getAuthTag()]);}
      else{const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(prop(props,T.HUKS_TAG_AE_TAG)));out=Buffer.concat([decipher.update(options.inData),decipher.final()]);}
      handles.delete(handle);return{outData:new Uint8Array(out)};},
    async abortSession(handle){calls.push({op:'abort'});handles.delete(handle);return{};},
  };
  const store={async put(key,value){calls.push({op:'put',key,value});values.set(key,value);},async flush(){calls.push({op:'flush'});if(hookFlush)await hookFlush();},async get(key,fallback){if(hookGet)await hookGet(key);return values.get(key)??fallback;}};
  const registry={credentialEpoch:()=>1,isCurrentGeneration:(_c,generation)=>generation===owner,currentGeneration:()=>owner,isCredentialOwnerCurrent:(_c,epoch,generation)=>epoch===1&&generation===owner,isCredentialDocumentCurrent:(_c,epoch,generation,nonce)=>epoch===1&&generation===owner&&nonce==='native-fixture-nonce'};
  const web={__LIFELINE_DOCUMENT_CHALLENGE__:'a'.repeat(64),__lifelineNativeComplete:(request,response)=>{const result=JSON.parse(response);pending.get(request)?.resolve(result);pending.delete(request);}};
  const controller={getUrl:()=>currentUrl,getLastJavascriptProxyCallingFrameUrl:()=>currentUrl,async runJavaScript(script){if(scriptGate&&script.includes('String(globalThis.__LIFELINE_DOCUMENT_CHALLENGE__'))await scriptGate();const value=vm.runInNewContext(script,{globalThis:web});return typeof value==='string'?value:JSON.stringify(value);}};
  const context=vm.createContext({exports:{},url:{URL},huks,cryptoFramework:{createRandom:()=>({generateRandomSync:n=>({data:new Uint8Array(randomBytes(n))})})},
    util:{TextEncoder:{create:()=>({encodeInto:s=>new Uint8Array(Buffer.from(s,'utf8'))})},TextDecoder:{create:()=>({decodeToString:b=>new TextDecoder('utf8',{fatal:true}).decode(b)})}},
    WebControllerRegistry:registry,console:{warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args),log:(...args)=>logs.push(args)},
  });
  if(realRegistry){
    const code=ts.transpileModule(registrySource.replace(/^import .*;\r?\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInContext(code,context);context.WebControllerRegistry=context.exports.WebControllerRegistry;context.WebControllerRegistry.attach(controller);context.WebControllerRegistry.markReady(controller);
  }
  vm.runInContext(transpiled+'\nglobalThis.cryptoHooks={encryptCredential,decryptCredential};',context);
  const createProxy=()=>new context.exports.LifelineNativeProxy(store,controller,{},()=>realRegistry?context.WebControllerRegistry.currentGeneration(controller):owner);
  const proxy=createProxy();
  const lease=()=>({pageEpoch:1,ownerGeneration:owner,documentNonce:'native-fixture-nonce'});
  const call=(operation,extra={},target=proxy)=>{const request=`aaaaaaaaaaaaaaaa.${++sequence}`,held=deferred();pending.set(request,held);target.callNative(request,operation,'',JSON.stringify({...lease(),...extra}));return held.promise;};
  const callRaw=(operation,input)=>{const request=`aaaaaaaaaaaaaaaa.${++sequence}`,held=deferred();pending.set(request,held);proxy.callNative(request,operation,'',JSON.stringify(input));return held.promise;};
  return{context,calls,logs,values,keys,handles,call,createProxy,callRaw,controller,registry:context.WebControllerRegistry,setChallenge(value){web.__LIFELINE_DOCUMENT_CHALLENGE__=value;},setScriptGate(fn){scriptGate=fn;},setUrl(value){currentUrl=value;},nextOwner(){owner++;},setGet(fn){hookGet=fn;},setFlush(fn){hookFlush=fn;},setFinish(fn){hookFinish=fn;},queryFails(){keyQueryFails=true;},finishFails(){finishFails=true;},hooks:context.cryptoHooks};
}
const checks=[];
async function check(name,body){try{await body();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:String(error?.message??error).replaceAll(credential.token,'[synthetic]').slice(0,1000)});}}
await check('actual HUKS adapter produces distinct nonces and UTF-8 roundtrips',async()=>{
  const h=harness(),text=JSON.stringify(credential);const a=await h.hooks.encryptCredential(text),b=await h.hooks.encryptCredential(text);assert.notEqual(JSON.parse(a).nonce,JSON.parse(b).nonce);assert.equal(await h.hooks.decryptCredential(a),text);assert.equal(await h.hooks.decryptCredential(b),text);assert.equal(h.calls.filter(c=>c.op==='key-generate').length,1);
});
await check('tampered GCM ciphertext is rejected without a new key',async()=>{
  const h=harness(),encrypted=JSON.parse(await h.hooks.encryptCredential(JSON.stringify(credential)));const original=encrypted.data[0];encrypted.data=(original==='0'?'1':'0')+encrypted.data.slice(1);await assert.rejects(()=>h.hooks.decryptCredential(JSON.stringify(encrypted)));assert.equal(h.calls.filter(c=>c.op==='key-generate').length,1);assert.equal(h.handles.size,0);
});
await check('missing decryption key never creates a replacement',async()=>{
  const h=harness(),encrypted=await h.hooks.encryptCredential(JSON.stringify(credential));h.keys.clear();await assert.rejects(()=>h.hooks.decryptCredential(encrypted));assert.equal(h.calls.filter(c=>c.op==='key-generate').length,1);
});
await check('keystore query error is not treated as missing key',async()=>{
  const h=harness();h.queryFails();await assert.rejects(()=>h.hooks.encryptCredential(JSON.stringify(credential)));assert.equal(h.calls.some(c=>c.op==='key-generate'),false);
});
await check('crypto failure aborts live HUKS session and has generic error',async()=>{
  const h=harness();h.finishFails();await assert.rejects(()=>h.hooks.encryptCredential(JSON.stringify(credential)),error=>!error.message.includes('synthetic-secret'));assert.equal(h.handles.size,0);assert.ok(h.calls.some(c=>c.op==='abort'));
});
await check('native save/load persists only ciphertext and nonsecret barrier',async()=>{
  const h=harness();assert.equal((await h.call('saveCredential',{credential})).ok,true);const loaded=await h.call('loadCredential');assert.equal(loaded.ok,true);assert.deepEqual(loaded.result.credential,credential);assert.equal([...h.values.values()].some(value=>String(value).includes(credential.token)),false);assert.equal(JSON.stringify(h.logs).includes(credential.token),false);
});
await check('username limit counts Unicode code points at 50 and 51 characters',async()=>{
  const accepted=harness(),fifty={token:'synthetic-token',username:'😀'.repeat(50)};assert.equal((await accepted.call('saveCredential',{credential:fifty})).ok,true);assert.deepEqual((await accepted.call('loadCredential')).result.credential,fifty);
  const rejected=harness(),fiftyOne={token:'synthetic-token',username:'😀'.repeat(51)};const encrypted=await rejected.hooks.encryptCredential(JSON.stringify(fiftyOne));rejected.values.set(CIPHER,encrypted);rejected.values.set(BARRIER,'present');assert.equal((await rejected.call('loadCredential')).ok,false);assert.equal((await rejected.call('saveCredential',{credential:fiftyOne})).ok,false);
});
for (const stage of [1,2,3]) await check(`failed credential flush ${stage} stays suppressed until clear`,async()=>{
  const h=harness();assert.equal((await h.call('saveCredential',{credential})).ok,true);
  let calls=0;h.setFlush(()=>{if(++calls===stage)throw Error('synthetic-flush-failure');});
  const replacement={token:'synthetic-unacknowledged',username:'test'};
  assert.equal((await h.call('saveCredential',{credential:replacement})).ok,false);
  h.setFlush(null);assert.equal(h.values.get(BARRIER),'pending');assert.equal((await h.call('loadCredential')).ok,false);
  h.context.exports.LifelineNativeProxy.credentialRecoveryRequired=false;
  assert.equal((await h.call('loadCredential',{},h.createProxy())).ok,false,'persisted pending survives a new instance with cleared process guard');
  assert.equal((await h.call('clearCredential')).ok,true);assert.equal((await h.call('loadCredential')).result.state,'cleared');
});
await check('failure after final flush reestablishes pending suppression',async()=>{
  const h=harness();assert.equal((await h.call('saveCredential',{credential})).ok,true);let barrierReads=0;
  h.setGet(key=>{if(key===BARRIER && ++barrierReads===2)throw Error('synthetic-final-readback-failure');});
  assert.equal((await h.call('saveCredential',{credential:{token:'synthetic-unacknowledged',username:'test'}})).ok,false);
  h.setGet(null);assert.equal(h.values.get(BARRIER),'pending');assert.equal((await h.call('loadCredential')).ok,false);
  assert.equal((await h.call('clearCredential')).ok,true);assert.equal((await h.call('loadCredential')).result.state,'cleared');
});
await check('native logout succeeds after key loss without crypto access',async()=>{
  const h=harness();assert.equal((await h.call('saveCredential',{credential})).ok,true);h.keys.clear();h.queryFails();h.calls.length=0;assert.equal((await h.call('clearCredential')).ok,true);const result=await h.call('loadCredential');assert.equal(result.result.state,'cleared');assert.equal(h.calls.some(c=>c.op==='init'||c.op==='key-generate'||c.op==='key-exists'),false);
});
await check('owner change during encryption prevents stale persistence',async()=>{
  const held=deferred(),h=harness();h.setFinish(()=>held.promise);h.call('saveCredential',{credential});await drain();h.nextOwner();held.resolve();await drain();assert.equal(h.values.has(CIPHER),false,'stale writes are rejected and their old-page replies are dropped');
});
for(const replacement of [false,true])await check(`clear cannot be overwritten across awaited readback (${replacement?'new proxy':'same proxy'})`,async()=>{
  const h=harness(),held=deferred();let paused=false;
  h.setGet(async key=>{if(key===CIPHER&&!paused){paused=true;await held.promise;}});
  h.call('saveCredential',{credential});await drain();assert.equal(paused,true);h.nextOwner();const clearing=h.call('clearCredential',{},replacement?h.createProxy():undefined);await drain();held.resolve();await clearing;assert.equal(h.values.get(BARRIER),'cleared');const loaded=await h.call('loadCredential');assert.equal(loaded.result.state,'cleared');
});

await check('current document handshake grants native-issued lease before pageReady',async()=>{
  const h=harness({realRegistry:true});const reply=await h.callRaw('claimCredentialOwner',{expectedOwnerGeneration:-1,documentChallenge:'a'.repeat(64)});assert.equal(reply.ok,true);assert.equal(reply.result.pageEpoch,h.registry.credentialEpoch(h.controller));assert.ok(reply.result.documentNonce);assert.notEqual(reply.result.documentNonce,'a'.repeat(64));const loaded=await h.callRaw('loadCredential',reply.result);assert.equal(loaded.ok,true);assert.equal(loaded.result.state,'missing');
});
await check('old document challenge cannot claim a replacement page',async()=>{
  const h=harness({realRegistry:true});h.setChallenge('b'.repeat(64));const reply=await h.callRaw('claimCredentialOwner',{expectedOwnerGeneration:-1,documentChallenge:'a'.repeat(64)});assert.equal(reply.ok,false);
});
await check('navigation during challenge verification rejects the old claim',async()=>{
  const h=harness({realRegistry:true}),held=deferred();h.setScriptGate(()=>held.promise);h.callRaw('claimCredentialOwner',{expectedOwnerGeneration:-1,documentChallenge:'a'.repeat(64)});await drain();h.registry.markLoading(h.controller);held.resolve();await drain();assert.equal(h.registry.currentGeneration(h.controller),-1,'navigation invalidates the old page callback before it can reply');
});

const final=await readFile(path.join(root,file),'utf8');
const registryFinal=await readFile(path.join(root,registryFile),'utf8');
const result={scope:'Actual ArkTS helper/proxy code transpiled by TypeScript in Node; HUKS API shape substitute uses Node AES-GCM; Preferences and document owner are controlled substitutes. NOT an ArkTS/SDK compile, hardware keystore, native durability or device acceptance.',file,sha256:createHash('sha256').update(source).digest('hex'),sourceStable:source===final&&registrySource===registryFinal,registrySha256:createHash('sha256').update(registrySource).digest('hex'),checks,passed:checks.filter(x=>x.pass).length,total:checks.length};
if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:result.passed,total:result.total,sourceStable:result.sourceStable,failures:checks.filter(x=>!x.pass)}));if(!result.sourceStable||result.passed!==result.total)process.exitCode=1;
