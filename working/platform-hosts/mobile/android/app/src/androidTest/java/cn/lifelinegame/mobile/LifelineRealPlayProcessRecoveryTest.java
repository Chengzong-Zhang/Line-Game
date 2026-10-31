package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** L33-F verifies visible recovery after force-stop with a test-only local eviction after durable mirroring. */
@RunWith(AndroidJUnit4.class)
public class LifelineRealPlayProcessRecoveryTest {
    private static final String KEY = "lifeline-local-game-session-v1";
    private static final String CLEAR_KEY = "lifeline-local-game-session-cleared-v1";
    private static final String FORMAT = "lifeline-local-session-envelope";
    private static final String TOMBSTONE = "__LIFELINE_CLEARED_V1__";
    private static final String TUTORIAL_SKIP_DIAGNOSTICS_MARKER = "__L33F_TUTORIAL_SKIP_DIAGNOSTICS__";
    private static final String READY = "document.readyState==='complete'&&globalThis.Capacitor"
            + "&&globalThis.Capacitor.Plugins&&globalThis.Capacitor.Plugins.LifelineStorage";

    private static String tutorialSkipDiagnosticsScript() {
        return """
                const tutorialSkipMarker='__L33F_TUTORIAL_SKIP_MARKER__';
                const compactSkipValue=(value,maxLength=640)=>{if(value instanceof Error)return (value.name||'Error')+': '+(value.message||String(value));try{const encoded=JSON.stringify(value);return (encoded===undefined?String(value):encoded).slice(0,maxLength);}catch(_error){return String(value).slice(0,maxLength);}};
                const readSkipStorageStatus=()=>{try{const status=globalThis.__LIFELINE_STORAGE_STATUS__??null;return status===null?null:JSON.parse(JSON.stringify(status));}catch(error){return {readError:compactSkipValue(error)};}};
                const summarizeSkipEnvelope=(raw,readStatus,readError)=>{if(readStatus!=='resolved')return {readStatus,present:null,revision:null,state:null,playContextTutorialDismissed:null,readError:readError??null};if(typeof raw!=='string')return {readStatus,present:false,revision:null,state:null,playContextTutorialDismissed:null,sessionParsed:false};let envelope=null,session=null,envelopeError=null,sessionError=null;try{envelope=JSON.parse(raw);}catch(error){envelopeError=compactSkipValue(error);}try{if(envelope?.payload)session=m.parseLocalGameSessionRecord(envelope.payload);}catch(error){sessionError=compactSkipValue(error);}return {readStatus,present:true,revision:envelope?.revision??null,state:envelope?.state??null,playContextTutorialDismissed:session?.playContext?.tutorialDismissed??null,sessionParsed:!!session,envelopeError,sessionError};};
                const readSkipStorageSnapshot=async(timeoutMs=500)=>{let localRaw=null,localReadStatus='resolved',localReadError=null;try{localRaw=globalThis.localStorage?.getItem('__L33F_SESSION_KEY__')??null;}catch(error){localReadStatus='rejected';localReadError=compactSkipValue(error);}let nativeReadStatus='resolved',nativeReadError=null,nativeRaw=null;let timer=null;const nativeRead=Promise.resolve().then(()=>p.loadRecord({key:'__L33F_SESSION_KEY__'})).then(result=>({status:'resolved',value:result?.value??null}),error=>({status:'rejected',error}));const timeoutRead=new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout'}),Math.max(1,timeoutMs));});const nativeOutcome=await Promise.race([nativeRead,timeoutRead]);if(timer!==null)clearTimeout(timer);nativeReadStatus=nativeOutcome.status;if(nativeOutcome.status==='resolved')nativeRaw=nativeOutcome.value;else if(nativeOutcome.status==='rejected')nativeReadError=compactSkipValue(nativeOutcome.error);else nativeReadError='native session read exceeded bounded diagnostic wait';return {local:summarizeSkipEnvelope(localRaw,localReadStatus,localReadError),native:summarizeSkipEnvelope(nativeRaw,nativeReadStatus,nativeReadError),rawEnvelopeEqual:typeof localRaw==='string'&&typeof nativeRaw==='string'&&localRaw===nativeRaw,storageStatus:readSkipStorageStatus()};};
                const tutorialSkipRoot=document.querySelector('#app'),tutorialSkipVueApp=tutorialSkipRoot?.__vue_app__??null,tutorialSkipVueInstance=tutorialSkipVueApp?._instance??null,tutorialSkipSetupState=tutorialSkipVueInstance?.setupState??null,tutorialSkipProxy=tutorialSkipVueInstance?.proxy??null;
                const unwrapSkipValue=value=>value&&typeof value==='object'&&Object.prototype.hasOwnProperty.call(value,'value')?value.value:value;
                const readTutorialSkipVueState=()=>{const get=(key)=>{try{if(tutorialSkipSetupState&&tutorialSkipSetupState[key]!==undefined)return tutorialSkipSetupState[key];if(tutorialSkipProxy&&tutorialSkipProxy[key]!==undefined)return tutorialSkipProxy[key];if(tutorialSkipVueInstance?.ctx&&tutorialSkipVueInstance.ctx[key]!==undefined)return tutorialSkipVueInstance.ctx[key];}catch(_error){}return undefined;};const active=unwrapSkipValue(get('tutorialActive')),controller=unwrapSkipValue(get('controller')),restoring=unwrapSkipValue(get('localGameRestoring'));return {rootAccessible:!!tutorialSkipRoot,vueAppAccessible:!!tutorialSkipVueApp,vueInstanceAccessible:!!tutorialSkipVueInstance,setupStateAccessible:!!tutorialSkipSetupState,tutorialActiveAccessible:active!==undefined,tutorialActive:typeof active==='boolean'?active:null,controllerPropertyAccessible:controller!==undefined,controllerAccessible:!!controller,localGameRestoringAccessible:restoring!==undefined,localGameRestoring:typeof restoring==='boolean'?restoring:null,skipTutorialType:typeof tutorialSkipSetupState?.skipTutorial};};
                const findTutorialSkipVNode=()=>{const queue=[tutorialSkipVueInstance?.subTree??null],visited=new Set();while(queue.length){const vnode=queue.shift();if(!vnode||typeof vnode!=='object'||visited.has(vnode))continue;visited.add(vnode);const isTutorialCard=vnode.el?.matches?.('.tutorial-card')===true||vnode.type?.name==='TutorialCard'||vnode.type?.__name==='TutorialCard';if(isTutorialCard&&vnode.props&&vnode.props.onSkip!==undefined)return vnode;if(vnode.component?.subTree)queue.push(vnode.component.subTree);if(Array.isArray(vnode.children))for(const child of vnode.children)if(child&&typeof child==='object')queue.push(child);}return null;};
                const tutorialSkipVNode=findTutorialSkipVNode(),originalSetupSkip=tutorialSkipSetupState?.skipTutorial,originalVNodeOnSkip=tutorialSkipVNode?.props?.onSkip;
                const tutorialSkipTrace={vueRootAccessible:!!tutorialSkipRoot,vueInstanceAccessible:!!tutorialSkipVueInstance,setupStateAccessible:!!tutorialSkipSetupState,setupStateSkipFunctionAccessible:typeof originalSetupSkip==='function',setupStateWrapperStatus:'unavailable',setupStateWrapperError:null,tutorialVNodeAccessible:!!tutorialSkipVNode,tutorialVNodeWrapperStatus:'unavailable',tutorialVNodeWrapperError:null,invocationCount:0,invocations:[],restoreErrors:[]};
                let activeTutorialSkipInvocation=null,setupSkipWrapper=null,vnodeSkipWrapper=null,setupSkipWrapped=false,vnodeSkipWrapped=false;
                const trackedTutorialSkip=(original,source)=>function(...args){const nested=activeTutorialSkipInvocation,entry=nested??{invocation: tutorialSkipTrace.invocationCount+1,calledAtUtc:new Date().toISOString(),calledAtMs:performance.now(),source,returnIsPromise:null,returnIsThenable:null,resolved:null,rejected:null,value:null,error:null,elapsedMs:null,promiseObserverError:null,resultPriority:0};if(!nested){tutorialSkipTrace.invocationCount++;tutorialSkipTrace.invocations.push(entry);activeTutorialSkipInvocation=entry;}const priority=source==='setupState.skipTutorial'?2:1;try{const result=Reflect.apply(original,this,args);let thenable=false;try{thenable=!!result&&(typeof result==='object'||typeof result==='function')&&typeof result.then==='function';}catch(error){entry.promiseObserverError=compactSkipValue(error);}if(priority>=entry.resultPriority){entry.resultPriority=priority;entry.source=source;entry.returnIsPromise=typeof Promise!=='undefined'&&result instanceof Promise;entry.returnIsThenable=thenable;}if(thenable&&(!entry.promiseObserverAttached||priority>=entry.promiseObserverPriority)){entry.promiseObserverAttached=true;entry.promiseObserverPriority=priority;try{Promise.resolve(result).then(value=>{if(priority>=entry.resultPriority){entry.resolved=true;entry.rejected=false;entry.value=compactSkipValue(value);entry.error=null;entry.elapsedMs=Math.max(0,performance.now()-entry.calledAtMs);}},error=>{if(priority>=entry.resultPriority){entry.resolved=false;entry.rejected=true;entry.value=null;entry.error=compactSkipValue(error);entry.elapsedMs=Math.max(0,performance.now()-entry.calledAtMs);}});}catch(error){entry.promiseObserverError=compactSkipValue(error);}}else if(priority>=entry.resultPriority){entry.resolved=true;entry.rejected=false;entry.value=compactSkipValue(result);entry.error=null;entry.elapsedMs=Math.max(0,performance.now()-entry.calledAtMs);}return result;}catch(error){if(priority>=entry.resultPriority){entry.returnIsPromise=false;entry.returnIsThenable=false;entry.resolved=false;entry.rejected=true;entry.error=compactSkipValue(error);entry.elapsedMs=Math.max(0,performance.now()-entry.calledAtMs);}throw error;}finally{if(!nested)activeTutorialSkipInvocation=null;}};
                if(!tutorialSkipSetupState){tutorialSkipTrace.setupStateWrapperStatus='unavailable';tutorialSkipTrace.setupStateWrapperError='Vue root setupState is unavailable';}else if(typeof originalSetupSkip!=='function'){tutorialSkipTrace.setupStateWrapperStatus='unavailable';tutorialSkipTrace.setupStateWrapperError='setupState.skipTutorial is not a function';}else{try{const descriptor=Object.getOwnPropertyDescriptor(tutorialSkipSetupState,'skipTutorial');const writable=!descriptor||descriptor.writable===true||typeof descriptor.set==='function';if(!writable)throw Error('setupState.skipTutorial property is not writable');setupSkipWrapper=trackedTutorialSkip(originalSetupSkip,'setupState.skipTutorial');if(!Reflect.set(tutorialSkipSetupState,'skipTutorial',setupSkipWrapper)||tutorialSkipSetupState.skipTutorial!==setupSkipWrapper)throw Error('setupState.skipTutorial wrapper assignment did not stick');setupSkipWrapped=true;tutorialSkipTrace.setupStateWrapperStatus='installed';}catch(error){tutorialSkipTrace.setupStateWrapperStatus='error';tutorialSkipTrace.setupStateWrapperError=compactSkipValue(error);}}
                if(!tutorialSkipVNode){tutorialSkipTrace.tutorialVNodeWrapperStatus='unavailable';tutorialSkipTrace.tutorialVNodeWrapperError='TutorialCard Vue vnode or onSkip handler is unavailable';}else if(typeof originalVNodeOnSkip!=='function'){tutorialSkipTrace.tutorialVNodeWrapperStatus='unavailable';tutorialSkipTrace.tutorialVNodeWrapperError='TutorialCard vnode onSkip handler is not a function';}else{try{vnodeSkipWrapper=setupSkipWrapped&&originalVNodeOnSkip===originalSetupSkip?setupSkipWrapper:trackedTutorialSkip(originalVNodeOnSkip,'TutorialCard vnode onSkip');if(!Reflect.set(tutorialSkipVNode.props,'onSkip',vnodeSkipWrapper)||tutorialSkipVNode.props.onSkip!==vnodeSkipWrapper)throw Error('TutorialCard vnode onSkip wrapper assignment did not stick');vnodeSkipWrapped=true;tutorialSkipTrace.tutorialVNodeWrapperStatus='installed';}catch(error){tutorialSkipTrace.tutorialVNodeWrapperStatus='error';tutorialSkipTrace.tutorialVNodeWrapperError=compactSkipValue(error);}}
                const snapshotTutorialSkipTrace=()=>({vueRootAccessible:tutorialSkipTrace.vueRootAccessible,vueInstanceAccessible:tutorialSkipTrace.vueInstanceAccessible,setupStateAccessible:tutorialSkipTrace.setupStateAccessible,setupStateSkipFunctionAccessible:tutorialSkipTrace.setupStateSkipFunctionAccessible,setupStateWrapperStatus:tutorialSkipTrace.setupStateWrapperStatus,setupStateWrapperError:tutorialSkipTrace.setupStateWrapperError,tutorialVNodeAccessible:tutorialSkipTrace.tutorialVNodeAccessible,tutorialVNodeWrapperStatus:tutorialSkipTrace.tutorialVNodeWrapperStatus,tutorialVNodeWrapperError:tutorialSkipTrace.tutorialVNodeWrapperError,invocationCount:tutorialSkipTrace.invocationCount,invocations:tutorialSkipTrace.invocations.map(entry=>({...entry,elapsedMs:entry.elapsedMs??Math.max(0,performance.now()-entry.calledAtMs)})),restoreErrors:[...tutorialSkipTrace.restoreErrors]});
                const restoreTutorialSkipWrappers=()=>{try{const currentVNode=findTutorialSkipVNode();if(currentVNode&&vnodeSkipWrapped&&(currentVNode.props?.onSkip===vnodeSkipWrapper||currentVNode.props?.onSkip===setupSkipWrapper))Reflect.set(currentVNode.props,'onSkip',originalVNodeOnSkip);}catch(error){tutorialSkipTrace.restoreErrors.push('vnode restore: '+compactSkipValue(error));}if(vnodeSkipWrapped&&tutorialSkipVNode&&tutorialSkipVNode.props?.onSkip===vnodeSkipWrapper){try{if(!Reflect.set(tutorialSkipVNode.props,'onSkip',originalVNodeOnSkip))throw Error('vnode onSkip restore returned false');}catch(error){tutorialSkipTrace.restoreErrors.push('vnode restore: '+compactSkipValue(error));}}if(setupSkipWrapped){try{if(!Reflect.set(tutorialSkipSetupState,'skipTutorial',originalSetupSkip)||tutorialSkipSetupState.skipTutorial!==originalSetupSkip)throw Error('setupState.skipTutorial restore did not stick');}catch(error){tutorialSkipTrace.restoreErrors.push('setupState restore: '+compactSkipValue(error));}}};
                const readTutorialSkipSample=async(elapsedMs,timeoutMs)=>{const storage=await readSkipStorageSnapshot(timeoutMs);const card=document.querySelector('.tutorial-card'),feedback=document.querySelector('.action-feedback');return {elapsedMs,sampledAtMs:performance.now(),cardPresent:!!card,actionFeedback:feedback?.innerText?.trim()||null,actionFeedbackClass:feedback?.className||null,vue:readTutorialSkipVueState(),local:storage.local,native:storage.native,rawEnvelopeEqual:storage.rawEnvelopeEqual,storageStatus:storage.storageStatus,wrapperTrace:snapshotTutorialSkipTrace()};};
                const runTutorialSkipDiagnostics=async(tutorial)=>{const buttons=Array.from(tutorial.querySelectorAll('button')),skip=buttons.find(button=>/^(Skip tutorial|跳过教学)$/.test(button.innerText.trim()))??null;const skipRect=skip?.getBoundingClientRect();const skipStyle=skip?getComputedStyle(skip):null;const visible=!!skip&&skip.getClientRects().length>0&&skipStyle?.display!=='none'&&skipStyle?.visibility!=='hidden';const beforeStorage=await readSkipStorageSnapshot(1000);const before={cardPresent:!!document.querySelector('.tutorial-card'),buttonCount:buttons.length,buttonText:skip?.innerText?.trim()??null,buttonDisabled:skip?.disabled??null,buttonVisible:visible,buttonRect:skipRect?{left:skipRect.left,top:skipRect.top,width:skipRect.width,height:skipRect.height}:null,vue:readTutorialSkipVueState(),local:beforeStorage.local,native:beforeStorage.native,rawEnvelopeEqual:beforeStorage.rawEnvelopeEqual,storageStatus:beforeStorage.storageStatus};const windowErrors=[];const onWindowError=event=>{if(windowErrors.length<12)windowErrors.push({type:'error',message:compactSkipValue(event?.message??event?.error??event),filename:event?.filename??null,lineNumber:event?.lineno??null,columnNumber:event?.colno??null});};const onUnhandledRejection=event=>{if(windowErrors.length<12)windowErrors.push({type:'unhandledrejection',reason:compactSkipValue(event?.reason??event)});};window.addEventListener('error',onWindowError);window.addEventListener('unhandledrejection',onUnhandledRejection);let click=null,first=null,last=null,observations=0,waitedMs=0,failure=null;const waitStarted=Date.now(),deadline=waitStarted+15000;try{if(!skip)failure='tutorial skip control unavailable';else if(!visible)failure='tutorial skip control is not visibly rendered';else{const event=new MouseEvent('click',{bubbles:true,cancelable:true,view:window});const dispatchResult=skip.dispatchEvent(event);click={method:'instrumentation-injected visible-button DOM MouseEvent',buttonText:skip.innerText.trim(),disabled:skip.disabled,visible:true,isTrusted:event.isTrusted,dispatchEventResult:dispatchResult};while(Date.now()<deadline){const remaining=Math.max(1,deadline-Date.now());last=await readTutorialSkipSample(Date.now()-waitStarted,Math.min(250,remaining));observations++;if(first===null)first=last;if(!last.cardPresent)break;if(Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));}waitedMs=Math.min(15000,Math.max(0,Date.now()-waitStarted));if(!last||last.cardPresent)failure='tutorial did not exit through its visible skip control';}}catch(error){failure='tutorial skip diagnostic probe failed: '+compactSkipValue(error);waitedMs=Math.min(15000,Math.max(0,Date.now()-waitStarted));}finally{window.removeEventListener('error',onWindowError);window.removeEventListener('unhandledrejection',onUnhandledRejection);restoreTutorialSkipWrappers();}const diagnostics={clickBefore:before,click,wait:{waitLimitMs:15000,waitedMs,observations,first,last},wrapperTrace:snapshotTutorialSkipTrace(),windowErrors:[...windowErrors]};if(failure)throw Error(failure+' '+tutorialSkipMarker+JSON.stringify(diagnostics));return diagnostics;};
                """.replace("__L33F_SESSION_KEY__", JSONObject.quote(KEY))
                .replace("__L33F_TUTORIAL_SKIP_MARKER__", TUTORIAL_SKIP_DIAGNOSTICS_MARKER);
    }

    @Test public void prepareSavedSession() throws Exception {
        requirePhase("prepare");
        inPage("prepare", "(async()=>{try{"
                + "const deadline=Date.now()+30000;while(Date.now()<deadline){"
                + "if(document.querySelector('.game-canvas')&&globalThis.__LIFELINE_MOBILE_SESSION_WRITER__?.writeSaved"
                + "&&globalThis.LifelinePlatform?.flushSessionMirror)break;await new Promise(r=>setTimeout(r,150));}"
                + "const canvas=document.querySelector('.game-canvas'),writer=globalThis.__LIFELINE_MOBILE_SESSION_WRITER__;"
                + "if(!canvas||!writer?.writeSaved)throw Error('live game canvas/session writer unavailable');"
                + "const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "const m=await import(new URL('/LocalGameSession.js',location.href).href);"
                + "const g=await import(new URL('/GameEngine.js',location.href).href);"
                + "const appState=await import(new URL('/OnlineAppState.js',location.href).href),defaultRulesVersion=appState.DEFAULT_RULES_VERSION;"
                + "const settingsFallback={...appState.normalizeGameSettings({playerCount:2,gridSize:9,startPlayer:'BLACK'}),turnTimerEnabled:false,turnTimeLimitSeconds:60,hintEnabled:true,hintMaxCount:3};"
                + "const env=()=>{const v=localStorage.getItem(" + JSONObject.quote(KEY) + ");return v?JSON.parse(v):null;};"
                + "const parsed=()=>{const e=env();return e?.payload?m.parseLocalGameSessionRecord(e.payload):null;};"
                + "const readControllerDiagnostics=()=>{const root=document.querySelector('#app'),instance=root?.__vue_app__?._instance,setup=instance?.setupState,proxy=instance?.proxy,controller=setup?.controller??proxy?.controller??instance?.ctx?.controller??null,gameState=setup?.gameState??proxy?.gameState??instance?.ctx?.gameState??null;let state=null,controllerReadError=null;try{state=typeof controller?.getGameState==='function'?controller.getGameState():gameState;}catch(e){controllerReadError=String(e);state=gameState;}let syncState=null,onlineActionSyncReadError=null;try{syncState=controller?._onlineActionSync?.getState?.()??null;}catch(e){onlineActionSyncReadError=String(e);}const hasController=!!controller,hasSync=!!controller?._onlineActionSync;return {controllerAvailable:hasController,controllerLookupPath:hasController?'#app.__vue_app__._instance.setupState.controller':'unavailable',controllerStateSource:typeof controller?.getGameState==='function'?'controller.getGameState()':gameState?'Vue root setupState.gameState':'unavailable',controllerState:{resetLockReason:state?.resetLockReason??null,interactionLockReason:state?.interactionLockReason??null},onlineActionSync:{available:hasSync,lookupPath:hasSync?'controller._onlineActionSync.getState().protocol.status':'unavailable',protocolStatus:syncState?.protocol?.status??null},controllerReadError,onlineActionSyncReadError};};"
                + "const tutorial=document.querySelector('.tutorial-card');"
                + tutorialSkipDiagnosticsScript()
                + "const tutorialSkipDiagnostics=tutorial?await runTutorialSkipDiagnostics(tutorial):null;"
                + "const settings=parsed()?.settings??settingsFallback;if(settings.playerCount!==2||settings.gridSize!==9||settings.startPlayer!=='BLACK'||defaultRulesVersion!=='territory-v3'||settings.rulesVersion!==defaultRulesVersion)throw Error('unexpected default solo match settings/rules version: '+JSON.stringify({settings,defaultRulesVersion}));"
                + "const uiState=()=>{const sampledAtMs=performance.now(),c=document.querySelector('.game-canvas'),b=document.querySelector('.duel-turn-banner'),s=document.querySelector('.duel-actions > button.action-button-secondary');return {sampledAtMs,canvas:{present:!!c,className:c?.className||null,ariaDisabled:c?.getAttribute('aria-disabled')??null,rect:(()=>{const r=c?.getBoundingClientRect();return r?{left:r.left,top:r.top,width:r.width,height:r.height}:null;})()},banner:{text:b?.innerText?.trim()||null,className:b?.className||null},actionFeedback:document.querySelector('.action-feedback')?.innerText?.trim()||null,tutorialPresent:!!document.querySelector('.tutorial-card'),startControl:s?{text:s.innerText.trim(),disabled:s.disabled,className:s.className}:null,controller:readControllerDiagnostics()};};"
                + "const startWaitStarted=Date.now(),startWaitDeadline=startWaitStarted+15000;let firstStartWait=null,lastStartWait=null,startWaitObservations=0,startButtonBefore=null;while(Date.now()<startWaitDeadline){const buttons=Array.from(document.querySelectorAll('.duel-actions > button.action-button-secondary')),visibleButtons=buttons.filter(b=>b.getClientRects().length>0),exactButtons=visibleButtons.filter(b=>/^(Start match|开始对局)$/.test(b.innerText.trim())),uiNow=uiState(),sample={elapsedMs:Date.now()-startWaitStarted,sampledAtMs:uiNow.sampledAtMs,totalButtonCount:buttons.length,visibleButtonCount:visibleButtons.length,exactTextButtonCount:exactButtons.length,startControl:exactButtons.length===1?{text:exactButtons[0].innerText.trim(),disabled:exactButtons[0].disabled,className:exactButtons[0].className}:null,visibleButtons:visibleButtons.map(b=>({text:b.innerText.trim(),disabled:b.disabled,className:b.className})),canvas:uiNow.canvas,banner:uiNow.banner,actionFeedback:uiNow.actionFeedback,tutorialPresent:uiNow.tutorialPresent,controller:uiNow.controller};startWaitObservations++;if(firstStartWait===null)firstStartWait=sample;lastStartWait=sample;if(exactButtons.length===1&&!exactButtons[0].disabled&&!uiNow.tutorialPresent){startButtonBefore=exactButtons[0];break;}await new Promise(r=>setTimeout(r,100));}const startWait={waitLimitMs:15000,waitedMs:Date.now()-startWaitStarted,observations:startWaitObservations,resolved:!!startButtonBefore,first:firstStartWait,last:lastStartWait};if(!startButtonBefore)throw Error('timed out waiting for exactly one visible, enabled DuelStrip Start match control: '+JSON.stringify({startWait,ui:uiState()}));const startUiBefore=uiState(),startControlTextBefore=startButtonBefore.innerText.trim(),startControlDisabledBefore=startButtonBefore.disabled;"
                + "const startEvent=new MouseEvent('click',{bubbles:true,cancelable:true,view:window}),startClickResult=startButtonBefore.dispatchEvent(startEvent),startUiAfterDispatch=uiState();let startedEnvelope=null;const startedDeadline=Date.now()+15000;while(Date.now()<startedDeadline){await globalThis.LifelinePlatform.flushSessionMirror();const localRaw=localStorage.getItem(" + JSONObject.quote(KEY) + "),localEnvelope=localRaw?JSON.parse(localRaw):null,localSession=localEnvelope?.payload?m.parseLocalGameSessionRecord(localEnvelope.payload):null,nativeRaw=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null,nativeEnvelope=typeof nativeRaw==='string'?JSON.parse(nativeRaw):null,nativeSession=nativeEnvelope?.payload?m.parseLocalGameSessionRecord(nativeEnvelope.payload):null,buttonNow=document.querySelector('.duel-actions > button.action-button-secondary'),uiNow=uiState();if(localSession?.match?.started===true&&nativeSession?.match?.started===true&&localSession.actions?.length===0&&nativeSession.actions?.length===0&&localEnvelope?.state==='saved'&&nativeEnvelope?.state==='saved'&&localRaw===nativeRaw&&localSession.settings.rulesVersion===defaultRulesVersion&&nativeSession.settings.rulesVersion===defaultRulesVersion&&localSession.match.players.BLACK.choice==='human'&&localSession.match.players.WHITE.choice==='human'&&uiNow.tutorialPresent===false&&buttonNow&&!/^(Start match|开始对局)$/.test(buttonNow.innerText.trim())&&uiNow.canvas.ariaDisabled==='false'&&!uiNow.canvas.className.includes('game-canvas-ai-thinking')){startedEnvelope={local:localEnvelope,native:nativeEnvelope,session:localSession,nativeSession,ui:uiNow,buttonTextAfter:buttonNow.innerText.trim()};break;}await new Promise(r=>setTimeout(r,100));}const startAction={wait:startWait,controlTextBefore:startControlTextBefore,disabledBefore:startControlDisabledBefore,dispatchEventResult:startClickResult,isTrusted:startEvent.isTrusted,inputType:'instrumentation-injected DOM MouseEvent; isTrusted is false',uiBefore:startUiBefore,uiAfterDispatch:startUiAfterDispatch,converged:!!startedEnvelope,buttonTextAfter:startedEnvelope?.buttonTextAfter??document.querySelector('.duel-actions > button.action-button-secondary')?.innerText?.trim()??null,uiAfterConvergence:startedEnvelope?.ui??uiState(),localRevision:startedEnvelope?.local?.revision??null,nativeRevision:startedEnvelope?.native?.revision??null,localState:startedEnvelope?.local?.state??null,nativeState:startedEnvelope?.native?.state??null,localActions:startedEnvelope?.session?.actions?.length??null,nativeActions:startedEnvelope?.nativeSession?.actions?.length??null,localNativeEnvelopeEqual:!!startedEnvelope&&JSON.stringify(startedEnvelope.local)===JSON.stringify(startedEnvelope.native),localRulesVersion:startedEnvelope?.session?.settings?.rulesVersion??null,nativeRulesVersion:startedEnvelope?.nativeSession?.settings?.rulesVersion??null,blackChoice:startedEnvelope?.session?.match?.players?.BLACK?.choice??null,whiteChoice:startedEnvelope?.session?.match?.players?.WHITE?.choice??null,localMatchStarted:startedEnvelope?.session?.match?.started??false,nativeMatchStarted:startedEnvelope?.nativeSession?.match?.started??false};const startFailed=!startedEnvelope;"
                + "let lastInput=null,canvasInputs=[];const click=([x,y])=>{const beforeUi=uiState(),px=rect.left+Math.round(ox+(x+y*.5)*scale),py=rect.top+Math.round(oy+y*.8660254037844386*scale),hit=document.elementFromPoint(px,py),ev=new MouseEvent('click',{bubbles:true,cancelable:true,view:window,clientX:px,clientY:py}),dispatchResult=canvas.dispatchEvent(ev),afterUi=uiState();lastInput={point:[x,y],eventType:'instrumentation-injected Canvas MouseEvent',isTrusted:ev.isTrusted,canvasRect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},parentSize:{width:frame.clientWidth,height:frame.clientHeight},dispatchCoordinates:{x:px,y:py},elementFromPoint:hit?{tag:hit.tagName,id:hit.id||null,className:typeof hit.className==='string'?hit.className:null}:null,eventTarget:'canvas (direct dispatch)',dispatchEventResult:dispatchResult,beforeUi,afterUi};canvasInputs.push(lastInput);};"
                + "const diagnostics=async(stage,n)=>{let l=null,localError=null;try{l=env();}catch(e){localError=String(e);}const localRaw=localStorage.getItem(" + JSONObject.quote(KEY) + ");let lp=null;try{lp=parsed();}catch(e){localError=String(e);}let r=null,nativeError=null;try{r=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;}catch(e){nativeError=String(e);}let nativeEnv=null,nativeSession=null;try{nativeEnv=typeof r==='string'?JSON.parse(r):null;if(nativeEnv?.payload)nativeSession=m.parseLocalGameSessionRecord(nativeEnv.payload);}catch(e){nativeError=nativeError||String(e);}const uiNow=uiState();return {stage,expectedActions:n,lastInput,startAction,startControl:uiNow.startControl,controller:uiNow.controller,canvas:uiNow.canvas,banner:uiNow.banner,actionFeedback:uiNow.actionFeedback,tutorialPresent:uiNow.tutorialPresent,local:{present:!!l,revision:l?.revision??null,state:l?.state??null,matchStarted:lp?.match?.started??null,actionCount:lp?.actions?.length??null,parseError:localError},native:{present:typeof r==='string',revision:nativeEnv?.revision??null,state:nativeEnv?.state??null,matchStarted:nativeSession?.match?.started??null,actionCount:nativeSession?.actions?.length??null,loadError:nativeError},rawEnvelopeEqual:typeof localRaw==='string'&&typeof r==='string'&&localRaw===r,storageStatus:globalThis.__LIFELINE_STORAGE_STATUS__||null};};if(startFailed)throw Error('visible Start match click did not produce an unlocked saved empty match: '+JSON.stringify(await diagnostics('start-match-timeout',0)));"
                + "const actualSettings=startedEnvelope.session.settings,rect=canvas.getBoundingClientRect(),frame=canvas.parentElement,w=Math.round(frame.clientWidth||rect.width),h=Math.round(frame.clientHeight||rect.height),top=52,bh=h-top;if(!(rect.width>0&&rect.height>0&&w>0&&h>top))throw Error('unlocked canvas/frame dimensions are not positive: '+JSON.stringify({rect:{width:rect.width,height:rect.height},frame:{width:w,height:h},startAction}));"
                + "const pts=g.getBoardPositions(actualSettings.gridSize,actualSettings.playerCount,actualSettings.boardShape),norm=pts.map(([x,y])=>[x+y*.5,y*.8660254037844386]);"
                + "const minX=Math.min(...norm.map(p=>p[0])),maxX=Math.max(...norm.map(p=>p[0])),minY=Math.min(...norm.map(p=>p[1])),maxY=Math.max(...norm.map(p=>p[1]));"
                + "const pad=Math.max(12,Math.min(w,bh)*.025),scale=Math.min((w-pad*2)/(maxX-minX+.9),(bh-pad*2)/(maxY-minY+.9));if(!(Number.isFinite(scale)&&scale>0))throw Error('unlocked canvas geometry has invalid scale: '+JSON.stringify({scale,w,h,rect:{width:rect.width,height:rect.height},actualSettings}));"
                + "const ox=(w-(maxX-minX)*scale)*.5-minX*scale,oy=top+(bh-(maxY-minY)*scale)*.5-minY*scale;"
                + "const playProbe=new g.GameEngine({...actualSettings});const legalityPreflight=[];for(const point of [[1,0],[7,0],[3,0]]){const currentPlayer=playProbe.currentPlayer,rulesVersion=playProbe.rulesVersion,legalMoves=playProbe.getLegalMoves(currentPlayer),legal=legalMoves.some(m=>JSON.stringify(m.point)===JSON.stringify(point));legalityPreflight.push({point,currentPlayer,rulesVersion,legal,legalMoves:legalMoves.map(m=>m.point)});if(!legal)throw Error('GameEngine read-only preflight rejected expected UI continuation: '+JSON.stringify({point,currentPlayer,rulesVersion,legalMoves:legalMoves.map(m=>m.point),actualSettings,startAction}));const result=playProbe.playMove(point);if(!result?.success)throw Error('GameEngine isolated legality probe could not advance expected prefix: '+JSON.stringify({point,currentPlayer,rulesVersion,result,actualSettings}));}const probeThirdMove=legalityPreflight[2];"
                + "const waitActions=async(n)=>{const end=Date.now()+10000;while(Date.now()<end){await globalThis.LifelinePlatform.flushSessionMirror();const l=env(),r=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value;const lp=parsed(),ne=typeof r==='string'?JSON.parse(r):null;"
                + "if(l&&ne&&lp?.actions?.length===n&&JSON.stringify(l)===JSON.stringify(ne)&&ne.state==='saved')return {local:l,native:ne,session:lp};await new Promise(r=>setTimeout(r,100));}throw Error('UI move did not converge to a durable local/native saved prefix: '+n+'; diagnostics='+JSON.stringify(await diagnostics('waitActions-timeout',n)));};"
                + "await globalThis.LifelinePlatform.flushSessionMirror();"
                + "let previousRevision=0;for(const [i,point] of [[1,[1,0]],[2,[actualSettings.gridSize-2,0]]]){const before=parsed()?.actions?.length??0;if(before!==i-1)throw Error('unexpected initial/action prefix '+before);click(point);const got=await waitActions(i);if(got.session.actions.length!==i||got.session.actions[i-1]?.type!=='player_move'||JSON.stringify(got.session.actions[i-1]?.point)!==JSON.stringify(point))throw Error('instrumented Canvas MouseEvent did not produce expected action '+i);if(got.local.revision<=previousRevision)throw Error('revision did not increase after UI move '+i);previousRevision=got.local.revision;}"
                + "const final=await waitActions(2);if(final.session.actions[0]?.type!=='player_move'||final.session.actions[1]?.type!=='player_move')throw Error('expected two instrumented Canvas MouseEvent moves');"
                + "const value=JSON.stringify(final.local),nativeSaved=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;if(typeof value!=='string'||nativeSaved!==value)throw Error('durable native envelope changed before local eviction');"
                + "localStorage.removeItem(" + JSONObject.quote(KEY) + ");const localEvictedBeforeForceStop=localStorage.getItem(" + JSONObject.quote(KEY) + ")===null,nativeRetainedAfterLocalEviction=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value===value;if(!localEvictedBeforeForceStop||!nativeRetainedAfterLocalEviction)throw Error('test-only local eviction/native retention check failed');"
                + "return {phase:'prepare',durable:true,localEvictedBeforeForceStop,nativeRetainedAfterLocalEviction,runToken:" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("runToken", "")) + ",localValue:value,nativeValue:value,localRevision:final.local.revision,nativeRevision:final.native.revision,localActions:2,nativeActions:2,localStartPlayer:final.session.settings.startPlayer,nativeStartPlayer:final.session.settings.startPlayer,rulesVersion:final.session.settings.rulesVersion,blackChoice:final.session.match.players.BLACK.choice,whiteChoice:final.session.match.players.WHITE.choice,nativeActionType:'player_move',nativeActionPoint:final.session.actions[0].point,revisionMonotone:final.local.revision>0,uiClickCount:2,inputType:'instrumentation-injected Canvas MouseEvent; isTrusted is false; does not prove physical touch, screen hit, or real-device behavior',startAction,tutorialSkipDiagnostics,legalityPreflight,canvasInputs,actionPrefix:final.session.actions};"
                + "}catch(error){throw Error(String(error));}})()");
    }

    @Test public void verifyColdStartVisibleMatchUi() throws Exception {
        requirePhase("verify");
        verifyVisibleMatchUi("(async()=>{"
                + "const expectedSha=" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("expectedNativeSha256", "")) + ";"
                + "const expectedRevision=Number(" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("expectedNativeRevision", "")) + ");"
                + "const runToken=" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("runToken", "")) + ";"
                + "const diag={phase:'verify',expectedNativeSha256:expectedSha,expectedNativeRevision:expectedRevision,runToken,"
                + "visibleMatchUiObserved:false,laidOutCanvas:false,redBanner:false,blueBanner:false,resumeNoticeMatches:false,"
                + "restoredActionCount:null,recoveryRoute:'unavailable',localRevision:null,nativeRevision:null,"
                + "localValue:null,nativeValue:null,localNativeEqual:false,localActions:null,nativeActions:null,"
                + "localTutorialDismissed:null,nativeTutorialDismissed:null,storageStatus:null,turn:null,bannerClass:null,"
                + "resumeNotice:null,canvasCssWidth:null,canvasCssHeight:null,canvasPixelWidth:null,canvasPixelHeight:null,nativeAuthorityReady:false,continuedUiMove:false,continuedRedBanner:false,continuedActionCount:null,continuedRevision:null,continuedPrefix:null,continuedLocalNativeEqual:false,errors:[]};"
                + "try{const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "const m=await import(new URL('/LocalGameSession.js',location.href).href);"
                + "const hashCache=new Map();const digest=async value=>{if(typeof value!=='string')return null;"
                + "if(hashCache.has(value))return hashCache.get(value);if(!globalThis.crypto?.subtle)return null;"
                + "const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));"
                + "const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');hashCache.set(value,hash);return hash;};"
                + "const deadline=Date.now()+30000;"
                + "while(Date.now()<deadline){try{"
                + "const canvas=document.querySelector('.game-canvas');"
                + "const rect=canvas?.getBoundingClientRect();"
                + "const banner=document.querySelector('.duel-turn-banner');"
                + "const turn=banner?.querySelector('strong')?.innerText?.trim()||null;"
                + "const noticeText=document.querySelector('.action-feedback')?.innerText?.trim()||null;"
                + "const resumeNoticeMatches=['已恢复保存的对局。','The saved match was restored.'].includes(noticeText);"
                + "const storageStatus=globalThis.__LIFELINE_STORAGE_STATUS__||null;"
                + "const localValue=localStorage.getItem(" + JSONObject.quote(KEY) + ");"
                + "const nativeValue=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;"
                + "const inspect=raw=>{if(typeof raw!=='string')return null;try{const envelope=JSON.parse(raw);"
                + "if(envelope?.format!==" + JSONObject.quote(FORMAT) + "||envelope?.state!=='saved'||!Number.isSafeInteger(envelope?.revision))return null;"
                + "const session=m.parseLocalGameSessionRecord(envelope.payload);return session?{revision:envelope.revision,session}:null;}catch(_e){return null;}};"
                + "const local=inspect(localValue),native=inspect(nativeValue);"
                + "const laidOutCanvas=!!(canvas&&canvas.width>0&&canvas.height>0&&rect?.width>0&&rect?.height>0);"
                + "const redBanner=!!(turn&&banner?.classList.contains('is-red')),blueBanner=!!(turn&&banner?.classList.contains('is-blue'));"
                + "const localActions=local?.session?.actions?.length??null;"
                + "const nativeActions=native?.session?.actions?.length??null;"
                + "const localActionPoint=local?.session?.actions?.[0]?.point??null;"
                + "const nativeActionPoint=native?.session?.actions?.[0]?.point??null;"
                + "const broadUi=!!(laidOutCanvas&&blueBanner&&localActions===2&&JSON.stringify(localActionPoint)==='[1,0]');"
                + "const recoveryRoute=storageStatus?.state==='restored'&&storageStatus?.source==='native'&&storageStatus?.operation==='restore'?'native-restore':"
                + "storageStatus?.state==='confirmed'&&storageStatus?.source==='local'&&storageStatus?.operation==='load'?'local-load':'unclassified';"
                + "const localSha=await digest(localValue),nativeSha=await digest(nativeValue);"
                + "const nativeAuthorityReady=!!(storageStatus?.state==='restored'&&storageStatus?.source==='native'&&storageStatus?.operation==='restore'"
                + "&&storageStatus?.nativeAvailable===true&&resumeNoticeMatches&&recoveryRoute==='native-restore'"
                + "&&local&&native&&localValue===nativeValue&&local.revision===expectedRevision&&native.revision===expectedRevision"
                + "&&localSha===expectedSha&&nativeSha===expectedSha&&localActions===2&&nativeActions===2"
                + "&&JSON.stringify(localActionPoint)==='[1,0]'&&JSON.stringify(nativeActionPoint)==='[1,0]'"
                + "&&JSON.stringify(local.session.actions[1]?.point)==='[7,0]'&&JSON.stringify(native.session.actions[1]?.point)==='[7,0]');"
                + "Object.assign(diag,{visibleMatchUiObserved:broadUi,laidOutCanvas,redBanner,blueBanner,resumeNoticeMatches,nativeAuthorityReady,"
                + "restoredActionCount:localActions,recoveryRoute,localRevision:local?.revision??null,nativeRevision:native?.revision??null,"
                + "localValue,nativeValue,localSha256:localSha,nativeSha256:nativeSha,localNativeEqual:typeof localValue==='string'&&localValue===nativeValue,"
                + "localActions,nativeActions,localActionType:local?.session?.actions?.[0]?.type??null,"
                + "localActionPoint,nativeActionType:native?.session?.actions?.[0]?.type??null,nativeActionPoint,"
                + "localTutorialDismissed:local?.session?.playContext?.tutorialDismissed??null,"
                + "nativeTutorialDismissed:native?.session?.playContext?.tutorialDismissed??null,storageStatus,turn,bannerClass:banner?.className||null,resumeNotice:noticeText,"
                + "canvasCssWidth:rect?.width??null,canvasCssHeight:rect?.height??null,canvasPixelWidth:canvas?.width??null,canvasPixelHeight:canvas?.height??null});"
                + "if(broadUi&&nativeAuthorityReady){const ptsModule=await import(new URL('/GameEngine.js',location.href).href);"
                + "const frame=canvas.parentElement,w=Math.round(frame.clientWidth||rect.width),h=Math.round(frame.clientHeight||rect.height),top=52,bh=h-top,grid=local.session.settings.gridSize,boardShape=local.session.settings.boardShape,pts=ptsModule.getBoardPositions(grid,local.session.settings.playerCount,boardShape),norm=pts.map(([x,y])=>[x+y*.5,y*.8660254037844386]);if(!(rect?.width>0&&rect?.height>0&&w>0&&h>top))throw Error('restored canvas/frame dimensions are not positive');"
                + "const minX=Math.min(...norm.map(p=>p[0])),maxX=Math.max(...norm.map(p=>p[0])),minY=Math.min(...norm.map(p=>p[1])),maxY=Math.max(...norm.map(p=>p[1])),pad=Math.max(12,Math.min(w,bh)*.025),scale=Math.min((w-pad*2)/(maxX-minX+.9),(bh-pad*2)/(maxY-minY+.9));if(!(Number.isFinite(scale)&&scale>0))throw Error('restored canvas geometry has invalid scale');const ox=(w-(maxX-minX)*scale)*.5-minX*scale,oy=top+(bh-(maxY-minY)*scale)*.5-minY*scale;"
                + "const continueEvent=new MouseEvent('click',{bubbles:true,cancelable:true,view:window,clientX:rect.left+Math.round(ox+(3+0*.5)*scale),clientY:rect.top+Math.round(oy+0*.8660254037844386*scale)}),continueDispatchResult=canvas.dispatchEvent(continueEvent);diag.continuationInput={point:[3,0],eventType:'instrumentation-injected Canvas MouseEvent',isTrusted:continueEvent.isTrusted,dispatchEventResult:continueDispatchResult,canvasDirectDispatch:true};"
                + "let continued=null;const continueUntil=Date.now()+10000;while(Date.now()<continueUntil){await globalThis.LifelinePlatform.flushSessionMirror();const lv=localStorage.getItem(" + JSONObject.quote(KEY) + "),nv=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null,le=typeof lv==='string'?JSON.parse(lv):null,ne=typeof nv==='string'?JSON.parse(nv):null,ls=le?.payload?m.parseLocalGameSessionRecord(le.payload):null,ns=ne?.payload?m.parseLocalGameSessionRecord(ne.payload):null;if(ls?.actions?.length===3&&ns?.actions?.length===3&&le.revision>expectedRevision&&le.revision===ne.revision&&lv===nv){continued={local:le,native:ne,session:ls,envelopeEqual:lv===nv};break;}await new Promise(r=>setTimeout(r,100));}"
                + "if(!continued||continued.session.actions[0]?.type!=='player_move'||JSON.stringify(continued.session.actions[0]?.point)!=='[1,0]'||continued.session.actions[1]?.type!=='player_move'||JSON.stringify(continued.session.actions[1]?.point)!=='[7,0]'||continued.session.actions[2]?.type!=='player_move'||JSON.stringify(continued.session.actions[2]?.point)!=='[3,0]')throw Error('restored game did not accept and persist the expected third instrumentation Canvas MouseEvent move');"
                + "const continuedBanner=document.querySelector('.duel-turn-banner'),continuedRedBanner=!!continuedBanner?.classList.contains('is-red');if(!continuedRedBanner)throw Error('third UI move did not show RED/is-red turn banner');"
                + "Object.assign(diag,{continuedUiMove:true,continuedRedBanner,continuedActionCount:continued.session.actions.length,continuedRevision:continued.local.revision,continuedPrefix:continued.session.actions,continuedLocalNativeEqual:continued.envelopeEqual,continuationInput:diag.continuationInput});break;}"
                + "}catch(e){diag.errors.push(String(e));}await new Promise(r=>setTimeout(r,150));}"
                + "}catch(e){diag.errors.push(String(e));}return diag;})()");
    }

    @Test public void cleanupSessionAndVerifyTombstone() throws Exception {
        requirePhase("cleanup");
        inPage("cleanup", "(async()=>{try{"
                + "const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "const result=await p.removeRecord({key:" + JSONObject.quote(KEY) + "});"
                + "localStorage.removeItem(" + JSONObject.quote(KEY) + ");"
                + "localStorage.removeItem(" + JSONObject.quote(CLEAR_KEY) + ");"
                + "const loaded=await p.loadRecord({key:" + JSONObject.quote(KEY) + "});"
                + "if(result?.durable!==true||loaded?.value!==" + JSONObject.quote(TOMBSTONE)
                + "||localStorage.getItem(" + JSONObject.quote(KEY) + ")!==null"
                + "||localStorage.getItem(" + JSONObject.quote(CLEAR_KEY) + ")!==null)"
                + "throw Error('native tombstone or Web marker cleanup failed');"
                + "return {phase:'cleanup',durable:true,tombstone:loaded.value,markersRemoved:true};"
                + "}catch(error){throw Error(String(error));}})()");
    }

    private static void verifyVisibleMatchUi(String expression) throws Exception {
        JSONObject observation = new JSONObject().put("phase", "verify");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> ref = new AtomicReference<>();
            scenario.onActivity(activity -> {
                if (activity.getBridge() != null) ref.set(activity.getBridge().getWebView());
            });
            WebView webView = ref.get();
            if (webView == null) observation.put("error", "MainActivity WebView was unavailable.");
            else observation = new JSONObject(awaitRaw(webView, "verify", expression));
        } catch (Throwable error) {
            observation.put("error", String.valueOf(error));
        }
        observation.put("phase", "verify");
        observation.put("inProcessPid", android.os.Process.myPid());
        addVerifyHashesAndDropRawValues(observation);
        Bundle bundle = new Bundle();
        bundle.putString("l33f_verify_observation", observation.toString());
        InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle);

        assertVerifyObservation(observation);
    }

    private static void addVerifyHashesAndDropRawValues(JSONObject observation) throws Exception {
        String localValue = observation.optString("localValue", "");
        String nativeValue = observation.optString("nativeValue", "");
        observation.put("localSha256", localValue.isEmpty() ? JSONObject.NULL : sha256(localValue));
        observation.put("nativeSha256", nativeValue.isEmpty() ? JSONObject.NULL : sha256(nativeValue));
        observation.remove("localValue");
        observation.remove("nativeValue");
        String expectedHash = observation.optString("expectedNativeSha256", "");
        long expectedRevision = observation.optLong("expectedNativeRevision", -1);
        observation.put("nativeMatchesExpected", expectedHash.matches("(?i)^[0-9a-f]{64}$")
                && expectedRevision > 0
                && expectedHash.equalsIgnoreCase(observation.optString("nativeSha256", ""))
                && observation.optLong("nativeRevision", -1) == expectedRevision);
        observation.put("localMatchesExpected", expectedHash.matches("(?i)^[0-9a-f]{64}$")
                && expectedRevision > 0
                && expectedHash.equalsIgnoreCase(observation.optString("localSha256", ""))
                && observation.optLong("localRevision", -1) == expectedRevision);
    }

    private static void assertVerifyObservation(JSONObject observation) throws Exception {
        assertTrue("Visible match UI was not observed: " + observation, observation.optBoolean("visibleMatchUiObserved"));
        assertTrue("Canvas was not laid out: " + observation, observation.optBoolean("laidOutCanvas"));
        assertTrue("Canvas CSS dimensions were not recorded: " + observation,
                observation.optDouble("canvasCssWidth", 0) > 0 && observation.optDouble("canvasCssHeight", 0) > 0);
        assertTrue("Canvas pixel dimensions were not recorded: " + observation,
                observation.optInt("canvasPixelWidth", 0) > 0 && observation.optInt("canvasPixelHeight", 0) > 0);
        assertTrue("Expected BLACK turn banner after two moves: " + observation, observation.optBoolean("blueBanner"));
        assertTrue("Restore notice did not match: " + observation, observation.optBoolean("resumeNoticeMatches"));
        assertTrue("Native authority restore gates were not all observed: " + observation, observation.optBoolean("nativeAuthorityReady"));
        assertEquals("Expected two restored UI moves", 2, observation.optInt("restoredActionCount", -1));
        assertEquals("Expected native-restore route", "native-restore", observation.optString("recoveryRoute"));
        assertEquals("Expected local/native equality", true, observation.optBoolean("localNativeEqual"));
        assertEquals("Local revision differs from prepared native revision", observation.optLong("expectedNativeRevision", -1), observation.optLong("localRevision", -2));
        assertEquals("Native revision differs from prepared revision", observation.optLong("expectedNativeRevision", -1), observation.optLong("nativeRevision", -2));
        assertTrue("Local copy does not match prepared native SHA256: " + observation, observation.optBoolean("localMatchesExpected"));
        assertTrue("Native copy does not match prepared SHA256: " + observation, observation.optBoolean("nativeMatchesExpected"));
        assertEquals("Expected two actions in native copy", 2, observation.optInt("nativeActions", -1));
        assertEquals("Expected restored move type", "player_move", observation.optString("localActionType"));
        assertEquals("Expected native move type", "player_move", observation.optString("nativeActionType"));
        assertEquals("Expected restored first move coordinate", "[1,0]", observation.optJSONArray("localActionPoint").toString());
        assertEquals("Expected native first move coordinate", "[1,0]", observation.optJSONArray("nativeActionPoint").toString());
        assertEquals("Expected prepare token to reach verify", InstrumentationRegistry.getArguments().getString("runToken", ""), observation.optString("runToken"));
        JSONObject status = observation.optJSONObject("storageStatus");
        assertNotNull("Missing storage recovery status: " + observation, status);
        assertEquals("Expected restored storage status", "restored", status.getString("state"));
        assertEquals("Expected native recovery source", "native", status.getString("source"));
        assertEquals("Expected restore operation", "restore", status.getString("operation"));
        assertTrue("Native storage was not available: " + observation, status.getBoolean("nativeAvailable"));
        assertTrue("No post-restore UI move was confirmed: " + observation, observation.optBoolean("continuedUiMove"));
        JSONObject continuationInput = observation.optJSONObject("continuationInput");
        assertNotNull("Missing continued-move input evidence: " + observation, continuationInput);
        assertEquals("[3,0]", continuationInput.optJSONArray("point").toString());
        assertEquals("instrumentation-injected Canvas MouseEvent", continuationInput.optString("eventType"));
        assertEquals("Instrumentation MouseEvent must not be described as a trusted physical touch", false, continuationInput.optBoolean("isTrusted", true));
        assertEquals("Third persisted move coordinate", "[3,0]", observation.optJSONArray("continuedPrefix").getJSONObject(2).getJSONArray("point").toString());
        assertTrue("RED/is-red turn banner was not observed after the third move: " + observation, observation.optBoolean("continuedRedBanner"));
        assertEquals("Third UI move must grow the history", 3, observation.optInt("continuedActionCount", -1));
        assertTrue("Continuation did not advance revision", observation.optLong("continuedRevision", -1) > observation.optLong("expectedNativeRevision", -1));
        assertTrue("Local/native saves did not converge after continuation", observation.optBoolean("continuedLocalNativeEqual"));
        assertEquals("Continuation must retain all three actions", 3, observation.optJSONArray("continuedPrefix").length());
    }

    private static void inPage(String name, String expression) throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> ref = new AtomicReference<>();
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge());
                ref.set(activity.getBridge().getWebView());
            });
            WebView webView = ref.get();
            assertNotNull(webView);
            JSONObject result = new JSONObject(await(webView, name, expression));
            result.put("inProcessPid", android.os.Process.myPid());
            assertEquals(name, result.getString("phase"));
            if ("prepare".equals(name)) {
                assertTrue(result.getBoolean("durable"));
                assertTrue("Two instrumented canvas events required", result.getInt("uiClickCount") >= 2);
                assertTrue("Revision must be positive", result.getInt("localRevision") > 0);
                assertEquals(result.getInt("localRevision"), result.getInt("nativeRevision"));
                assertEquals(2, result.getInt("localActions"));
                assertEquals(2, result.getInt("nativeActions"));
                assertTrue("Prepare must evict only the local WebView session key before force-stop", result.getBoolean("localEvictedBeforeForceStop"));
                assertTrue("Native plugin must retain the exact saved envelope after local eviction", result.getBoolean("nativeRetainedAfterLocalEviction"));
                assertEquals("BLACK", result.getString("localStartPlayer"));
                assertEquals("BLACK", result.getString("nativeStartPlayer"));
                assertEquals("territory-v3", result.getString("rulesVersion"));
                assertEquals("human", result.getString("blackChoice"));
                assertEquals("human", result.getString("whiteChoice"));
            if (result.has("tutorialSkipDiagnostics") && !result.isNull("tutorialSkipDiagnostics")) {
                JSONObject tutorialSkip = result.getJSONObject("tutorialSkipDiagnostics");
                JSONObject skipBefore = tutorialSkip.getJSONObject("clickBefore");
                JSONObject skipClick = tutorialSkip.getJSONObject("click");
                JSONObject skipWait = tutorialSkip.getJSONObject("wait");
                assertTrue("Tutorial skip target must be visible", skipBefore.getBoolean("buttonVisible"));
                assertEquals("instrumentation-injected visible-button DOM MouseEvent", skipClick.getString("method"));
                assertFalse("Tutorial skip input must be an untrusted injected DOM MouseEvent", skipClick.getBoolean("isTrusted"));
                assertTrue("Tutorial skip wait must remain bounded", skipWait.getLong("waitLimitMs") <= 15000);
                assertTrue("Tutorial skip wait emitted no samples", skipWait.getInt("observations") > 0);
                assertFalse("Tutorial card remained after the visible skip action", skipWait.getJSONObject("last").getBoolean("cardPresent"));
            }
                assertEquals("territory-v3", result.getJSONObject("startAction").getString("localRulesVersion"));
                JSONObject startWait = result.getJSONObject("startAction").getJSONObject("wait");
                assertTrue("Start control did not resolve within the bounded wait", startWait.getBoolean("resolved"));
                assertTrue("Start control wait exceeded 15 seconds", startWait.getLong("waitedMs") <= 15000);
                assertTrue("Start control wait emitted no observations", startWait.getInt("observations") > 0);
                JSONObject lastStartWait = startWait.getJSONObject("last");
                assertEquals("Expected one visible exact Start match control at resolution", 1, lastStartWait.getInt("exactTextButtonCount"));
                assertFalse("Resolved Start match control was still disabled", lastStartWait.getJSONArray("visibleButtons").getJSONObject(0).getBoolean("disabled"));
                JSONObject sampledStartControl = lastStartWait.getJSONObject("startControl");
                assertFalse("Same-frame Start match control was still disabled", sampledStartControl.getBoolean("disabled"));
                assertTrue("Start diagnostic sample timestamp is missing", lastStartWait.has("sampledAtMs"));
                JSONObject controllerDiagnostics = lastStartWait.getJSONObject("controller");
                JSONObject controllerState = controllerDiagnostics.getJSONObject("controllerState");
                assertTrue("Same-frame interaction lock diagnostic is missing", controllerState.has("interactionLockReason"));
                assertTrue("Same-frame reset lock diagnostic is missing", controllerState.has("resetLockReason"));
                JSONObject onlineActionSyncDiagnostics = controllerDiagnostics.getJSONObject("onlineActionSync");
                assertTrue("Same-frame online action protocol diagnostic is missing", onlineActionSyncDiagnostics.has("protocolStatus"));
                assertTrue(result.getJSONObject("startAction").getString("controlTextBefore").matches("^(Start match|开始对局)$"));
                assertFalse("Start control input must be an untrusted injected DOM MouseEvent", result.getJSONObject("startAction").getBoolean("isTrusted"));
                assertEquals(2, result.getJSONArray("canvasInputs").length());
                for (int i = 0; i < result.getJSONArray("canvasInputs").length(); i++) {
                    assertFalse("Canvas input must be an untrusted injected MouseEvent", result.getJSONArray("canvasInputs").getJSONObject(i).getBoolean("isTrusted"));
                }
                assertEquals(3, result.getJSONArray("legalityPreflight").length());
                assertEquals("[3,0]", result.getJSONArray("legalityPreflight").getJSONObject(2).getJSONArray("point").toString());
                assertTrue("Continuation point was not legal in isolated GameEngine preflight", result.getJSONArray("legalityPreflight").getJSONObject(2).getBoolean("legal"));
                assertEquals("player_move", result.getString("nativeActionType"));
                assertEquals("[1,0]", result.getJSONArray("nativeActionPoint").toString());
                assertEquals(2, result.getJSONArray("actionPrefix").length());
                assertEquals("[1,0]", result.getJSONArray("actionPrefix").getJSONObject(0).getJSONArray("point").toString());
                assertEquals("[7,0]", result.getJSONArray("actionPrefix").getJSONObject(1).getJSONArray("point").toString());
                String localSha256 = sha256(result.getString("localValue"));
                String nativeSha256 = sha256(result.getString("nativeValue"));
                assertTrue("Malformed prepare SHA256", localSha256.matches("^[0-9a-f]{64}$") && nativeSha256.matches("^[0-9a-f]{64}$"));
                assertEquals("Local and native envelopes must converge", localSha256, nativeSha256);
                JSONObject ready = new JSONObject();
                ready.put("phase", "prepare");
                ready.put("durable", true);
                ready.put("localRevision", result.getInt("localRevision"));
                ready.put("nativeRevision", result.getInt("nativeRevision"));
                ready.put("revisionMonotone", result.getBoolean("revisionMonotone"));
                ready.put("localSha256", localSha256);
                ready.put("nativeSha256", nativeSha256);
                ready.put("localActions", 2);
                ready.put("nativeActions", 2);
                ready.put("localEvictedBeforeForceStop", result.getBoolean("localEvictedBeforeForceStop"));
                ready.put("nativeRetainedAfterLocalEviction", result.getBoolean("nativeRetainedAfterLocalEviction"));
                ready.put("uiClickCount", result.getInt("uiClickCount"));
                ready.put("localStartPlayer", "BLACK");
                ready.put("nativeStartPlayer", "BLACK");
                ready.put("rulesVersion", result.getString("rulesVersion"));
                ready.put("blackChoice", result.getString("blackChoice"));
                ready.put("whiteChoice", result.getString("whiteChoice"));
                ready.put("inputType", result.getString("inputType"));
                ready.put("startAction", result.getJSONObject("startAction"));
                ready.put("legalityPreflight", result.getJSONArray("legalityPreflight"));
                ready.put("canvasInputs", result.getJSONArray("canvasInputs"));
                ready.put("nativeActionType", "player_move");
                ready.put("nativeActionPoint", result.getJSONArray("nativeActionPoint"));
                ready.put("actionPrefix", result.getJSONArray("actionPrefix"));
                String runToken = InstrumentationRegistry.getArguments().getString("runToken", "");
                assertTrue("Missing L33-F run token", !runToken.trim().isEmpty());
                ready.put("runToken", runToken);
                ready.put("inProcessPid", result.getInt("inProcessPid"));
                ready.put("holdState", "awaiting-external-force-stop");
                Bundle bundle = new Bundle();
                bundle.putString("l33f_prepare_ready", ready.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle);
                assertTrue("Timed out waiting for external L33-F force-stop",
                        new CountDownLatch(1).await(120, TimeUnit.SECONDS));
            } else {
                assertTrue(result.getBoolean("durable"));
                assertTrue(result.getBoolean("markersRemoved"));
                assertEquals(TOMBSTONE, result.getString("tombstone"));
                Bundle observation = new Bundle();
                observation.putString("l33f_cleanup_observation", result.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, observation);
            }
        }
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte item : digest) hex.append(String.format("%02x", item & 0xff));
        return hex.toString();
    }

    private static void requirePhase(String expected) {
        String phase = InstrumentationRegistry.getArguments().getString("phase", "");
        Assume.assumeTrue("Run with instrumentation argument phase=" + expected, expected.equals(phase));
    }

    private static String await(WebView webView, String name, String expression) throws Exception {
        JSONObject result = new JSONObject(awaitRaw(webView, name, expression));
        assertTrue("L33-F " + name + " failed: " + result, !result.has("error"));
        return result.toString();
    }

    private static String awaitRaw(WebView webView, String name, String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(45);
        String started = "__L33F_STARTED_" + name;
        String resultName = "__L33F_RESULT_" + name;
        String probe = "(function(){try{if((" + READY + ")&&!globalThis[" + JSONObject.quote(started) + "]){globalThis["
                + JSONObject.quote(started) + "]=true;Promise.resolve(" + expression + ").then(v=>{globalThis["
                + JSONObject.quote(resultName) + "]=JSON.stringify(v);},e=>{globalThis[" + JSONObject.quote(resultName)
                + "]=JSON.stringify({phase:" + JSONObject.quote(name) + ",error:String(e)});});}return globalThis["
                + JSONObject.quote(resultName) + "]||null;}catch(e){return JSON.stringify({phase:" + JSONObject.quote(name)
                + ",error:String(e)});}})()";
        webView.post(new Runnable() {
            @Override public void run() {
                if (done.getCount() == 0) return;
                if (System.currentTimeMillis() >= deadline) {
                    result.set("{\"phase\":" + JSONObject.quote(name) + ",\"error\":\"phase probe timed out\"}");
                    done.countDown();
                    return;
                }
                webView.evaluateJavascript(probe, value -> {
                    try {
                        Object decoded = new JSONTokener(value).nextValue();
                        if (decoded instanceof String && !((String) decoded).isEmpty()) {
                            result.set((String) decoded);
                            done.countDown();
                        } else webView.postDelayed(this, 200);
                    } catch (Exception ignored) {
                        webView.postDelayed(this, 200);
                    }
                });
            }
        });
        if (!done.await(47, TimeUnit.SECONDS)) {
            return "{\"phase\":" + JSONObject.quote(name) + ",\"error\":\"phase callback timed out\"}";
        }
        return result.get();
    }
}
