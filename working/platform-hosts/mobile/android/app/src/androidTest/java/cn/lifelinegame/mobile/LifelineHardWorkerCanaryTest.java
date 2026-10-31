package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the packaged LocalAIWorkerFactory and Hard module Worker in Android WebView. */
@RunWith(AndroidJUnit4.class)
public class LifelineHardWorkerCanaryTest {

    private static final String START_HARD_MATCH = "(function(){try{"
            + "globalThis.__l33gHardCanaryProgress='waiting-visible-app';if(globalThis.__l33gHardCanaryStarted)return null;"
            + "if(document.readyState!=='complete'||!document.querySelector('#app')?.children?.length)return null;"
            + "globalThis.__l33gHardCanaryStarted=true;const BaseWorker=globalThis.Worker,entry={url:null,options:null,request:null,messages:[],terminated:false,worker:null,workerError:null,progress:'app-ready',lastConstructedUrl:null,pauseObserved:false};"
            + "globalThis.__l33gHardCanaryWorker=entry;globalThis.__l33gHardCanaryResult=null;"
            + "globalThis.Worker=class extends BaseWorker{constructor(url,options){super(url,options);this.__l33gUrl=new URL(url,location.href).href;this.__l33gOptions=options||null;entry.lastConstructedUrl=this.__l33gUrl;}"
            + "postMessage(data,transfer){if(data?.type==='COMPUTE'&&!entry.request){entry.request=JSON.parse(JSON.stringify(data));entry.worker=this;entry.url=this.__l33gUrl;entry.options=this.__l33gOptions;entry.progress='compute-sent';globalThis.__l33gHardCanaryProgress=entry.progress;"
            + "this.addEventListener('message',event=>{const value=event.data;if(value?.requestId===entry.request?.requestId&&['READY','RESULT','ERROR'].includes(value?.type)){entry.messages.push(value);entry.progress=value.type.toLowerCase();globalThis.__l33gHardCanaryProgress=entry.progress;"
            + "if(value.type==='RESULT'){const pause=[...document.querySelectorAll('.duel-actions button')].find(button=>/^(Pause AI|暂停 AI)$/.test(button.innerText.trim()));if(pause&&!pause.disabled){pause.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));entry.pauseObserved=true;}}}});"
            + "this.addEventListener('error',event=>{entry.workerError=String(event.message||event);entry.progress='worker-error';globalThis.__l33gHardCanaryProgress=entry.progress;});}"
            + "return transfer===undefined?super.postMessage(data):super.postMessage(data,transfer);}terminate(){if(entry.worker===this)entry.terminated=true;return super.terminate();}};"
            + "const visible=element=>!!element&&element.getClientRects().length>0,waitFor=async(label,predicate,ms=12000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out waiting for '+label);},click=(element,label)=>{if(!visible(element)||element.disabled)throw Error(label+' is not visible and enabled');element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));},select=async(element,value,label)=>{if(!visible(element)||element.disabled)throw Error(label+' is not visible and enabled');element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));await waitFor(label+' to apply',()=>element.value===value,3000);};"
            + "(async()=>{entry.progress='visible-tutorial';globalThis.__l33gHardCanaryProgress=entry.progress;const tutorial=document.querySelector('.tutorial-card');if(tutorial){const skip=await waitFor('visible tutorial skip button',()=>{const button=tutorial.querySelector('.text-button');return visible(button)&&!button.disabled?button:null;});click(skip,'tutorial skip button');await waitFor('tutorial to close',()=>!document.querySelector('.tutorial-card'));}"
            + "entry.progress='open-board-settings';globalThis.__l33gHardCanaryProgress=entry.progress;const boardDock=await waitFor('visible Board deck launcher',()=>{const button=document.querySelector('.dock-launcher-board');return visible(button)&&!button.disabled?button:null;});click(boardDock,'Board deck launcher');"
            + "entry.progress='visible-settings';globalThis.__l33gHardCanaryProgress=entry.progress;const count=await waitFor('visible player count choices',()=>{const button=[...document.querySelectorAll('#player-count button')].find(item=>item.innerText.trim()==='3');return visible(button)&&!button.disabled?button:null;});click(count,'three-player choice');await waitFor('three-player selection to apply',()=>count.getAttribute('aria-checked')==='true');"
            + "const shape=await waitFor('visible triangle board choice',()=>{const button=document.querySelector('#board-shape button[data-board-shape=triangle]');return visible(button)&&!button.disabled?button:null;});click(shape,'triangle board choice');await waitFor('triangle board selection to apply',()=>shape.getAttribute('aria-checked')==='true');"
            + "const size=await waitFor('visible 5x5 grid choice',()=>{const button=[...document.querySelectorAll('#grid-size button')].find(item=>item.innerText.trim()==='5');return visible(button)&&!button.disabled?button:null;});click(size,'5x5 grid choice');await waitFor('5x5 selection to apply',()=>size.getAttribute('aria-checked')==='true');"
            + "for(const color of ['BLACK','WHITE','PURPLE']){const selectBox=await waitFor('visible '+color+' controller choice',()=>{const element=document.querySelector('#local-player-'+color);return visible(element)&&!element.disabled?element:null;});select(selectBox,'ai-hard',color+' Hard AI choice');}"
            + "const start=await waitFor('visible Start match button',()=>{const button=document.querySelector('.starting-point-start');return visible(button)&&!button.disabled?button:null;});entry.progress='visible-start-match';globalThis.__l33gHardCanaryProgress=entry.progress;click(start,'Start match button');"
            + "entry.progress='wait-worker-result';globalThis.__l33gHardCanaryProgress=entry.progress;const deadline=Date.now()+60000;while(Date.now()<deadline){const request=entry.request,terminal=entry.messages.find(item=>item?.type==='RESULT'||item?.type==='ERROR');if(entry.workerError)throw Error('Hard Worker runtime error: '+entry.workerError);"
            + "if(request&&terminal){if(terminal.type==='ERROR')throw Error('Hard Worker ERROR: '+JSON.stringify(terminal));if(entry.messages.length!==2||entry.messages[0].type!=='READY'||entry.messages[1].type!=='RESULT')throw Error('Expected first request messages exactly READY then RESULT: '+JSON.stringify(entry.messages));"
            + "const move=terminal.moves?.[0],state=request.serializedState;const [{GameEngine},{deserializeEngineEdges},{restoreState}]=await Promise.all([import(new URL('/GameEngine.js',location.href).href),import(new URL('/AIStateProtocol.js',location.href).href),import(new URL('/AIEngine.js',location.href).href)]);"
            + "const engine=new GameEngine({gridSize:state.gridSize,playerCount:state.playerCount,boardShape:state.boardShape,startPlayer:state.startPlayer,initialPositions:state.initialPositions,rulesVersion:state.rulesVersion});restoreState(engine,{grid:new Map(state.gridEntries),edges:deserializeEngineEdges(state,engine.activePlayers),historyHashes:new Set(state.historyHashes),consecutiveSkips:state.consecutiveSkips,resignedPlayers:new Set(state.resignedPlayers||[]),currentPlayer:state.currentPlayer,gameOver:state.gameOver,turnCount:state.turnCount,positionRevision:state.positionRevision||0,cachedTerritories:engine.cachedTerritories});"
            + "const legalMove=move?.type==='move'&&Array.isArray(move.point)&&move.point.length===2&&move.point.every(Number.isInteger)&&engine._evaluateMove(move.point,request.aiPlayer).legal;if(!legalMove)throw Error('Hard Worker result was not a legal move in its exact source snapshot: '+JSON.stringify(move));"
            + "while((!entry.terminated||!entry.pauseObserved)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));if(!entry.terminated||!entry.pauseObserved)throw Error('Visible product pause did not terminate the active Hard Worker');"
            + "globalThis.Worker=BaseWorker;globalThis.__l33gHardCanaryResult=JSON.stringify({workerUrl:entry.url,workerOptions:entry.options,request:{requestId:request.requestId,aiPlayer:request.aiPlayer,strategy:request.strategy,modelId:request.modelId,serializedState:state},messages:entry.messages,legalMove,move,terminated:entry.terminated,aiDuelPaused:entry.pauseObserved,location:location.href});return;}await new Promise(resolve=>setTimeout(resolve,100));}const banner=document.querySelector('.duel-turn-banner'),pauseButtons=[...document.querySelectorAll('.duel-actions button')].map(button=>button.innerText.trim()),selects=['BLACK','WHITE','PURPLE'].map(color=>({color,value:document.querySelector('#local-player-'+color)?.value??null}));throw Error('Hard Worker did not return READY and RESULT within 60 seconds: '+JSON.stringify({progress:entry.progress,requestSeen:!!entry.request,requestId:entry.request?.requestId??null,player:entry.request?.aiPlayer??null,strategy:entry.request?.strategy??null,modelId:entry.request?.modelId??null,messages:entry.messages.map(message=>message.type),workerError:entry.workerError,lastConstructedUrl:entry.lastConstructedUrl,selects,pauseButtons,banner:banner?.innerText?.trim()??null,startText:document.querySelector('.starting-point-start')?.innerText?.trim()??null,visibleAlerts:[...document.querySelectorAll('[role=alert],[role=status]')].filter(visible).map(element=>element.innerText.trim()).slice(0,8)}));})()"
            + ".catch(error=>{globalThis.Worker=BaseWorker;if(!entry.terminated){try{entry.worker?.terminate();}catch(_error){}}globalThis.__l33gHardCanaryResult=JSON.stringify({error:String(error?.stack||error),terminated:entry.terminated,progress:entry.progress,requestSeen:!!entry.request,requestId:entry.request?.requestId??null,player:entry.request?.aiPlayer??null,strategy:entry.request?.strategy??null,modelId:entry.request?.modelId??null,messages:entry.messages.map(message=>message.type),workerError:entry.workerError,lastConstructedUrl:entry.lastConstructedUrl});});return null;"
            + "}catch(error){globalThis.__l33gHardCanaryError=String(error?.stack||error);return JSON.stringify({error:String(error?.stack||error)});}})()";

    private static final String READ_RESULT = "(function(){try{"
            + "if(globalThis.__l33gHardCanaryError)return JSON.stringify({error:globalThis.__l33gHardCanaryError});"
            + "return globalThis.__l33gHardCanaryResult||null;"
            + "}catch(error){return JSON.stringify({error:String(error?.stack||error)});}})()";

    private static final String TIMEOUT_DIAGNOSTIC = "(function(){try{const root=document.getElementById('app'),entry=globalThis.__l33gHardCanaryWorker;return JSON.stringify({error:'JavaScript canary deadline',progress:globalThis.__l33gHardCanaryProgress||null,location:location.href,readyState:document.readyState,rootPresent:!!root,rootChildCount:root?.children?.length??null,vueAppPresent:!!root?.__vue_app__,vueParentComponentPresent:!!root?.__vueParentComponent__,tutorialPresent:!!document.querySelector('.tutorial-card'),visibleSettings:!!document.querySelector('#player-count'),visibleStart:!!document.querySelector('.starting-point-start'),visiblePause:!![...document.querySelectorAll('.duel-actions button')].find(button=>/^(Pause AI|暂停 AI)$/.test(button.innerText.trim())),bootFailure:document.querySelector('#app-failure, .app-failure, [role=alert]')?.innerText?.slice(0,500)??null,worker:entry?{progress:entry.progress,url:entry.url,lastConstructedUrl:entry.lastConstructedUrl,requestId:entry.request?.requestId??null,messageTypes:entry.messages?.map(message=>message.type)??[],workerError:entry.workerError,pauseObserved:entry.pauseObserved}:null});}catch(error){return JSON.stringify({error:String(error)});}})()";

    @Test
    public void packagedHardWorkerReturnsBoundResultAndTerminatesOnPause() throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull("Capacitor bridge should be initialized", activity.getBridge());
                WebView webView = activity.getBridge().getWebView();
                assertNotNull("Capacitor should create its WebView", webView);
                long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(100);
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        if (completed.getCount() == 0) return;
                        if (System.currentTimeMillis() >= deadline) {
                            webView.evaluateJavascript(TIMEOUT_DIAGNOSTIC, diagnostic -> {
                                try {
                                    Object decoded = new JSONTokener(diagnostic).nextValue();
                                    result.set(decoded instanceof String ? (String) decoded : "{\"error\":\"Hard Worker canary exceeded 100 second deadline\"}");
                                } catch (Exception ignored) {
                                    result.set("{\"error\":\"Hard Worker canary exceeded 100 second deadline\"}");
                                }
                                completed.countDown();
                            });
                            return;
                        }
                        webView.evaluateJavascript(START_HARD_MATCH, ignored -> webView.evaluateJavascript(READ_RESULT, value -> {
                            try {
                                Object decoded = new JSONTokener(value).nextValue();
                                if (decoded instanceof String && !((String) decoded).isEmpty()) {
                                    result.set((String) decoded);
                                    completed.countDown();
                                } else webView.postDelayed(this, 100);
                            } catch (Exception ignoredResult) {
                                webView.postDelayed(this, 100);
                            }
                        }));
                    }
                });
            });

            assertTrue("Packaged Hard module Worker did not finish within its hard deadline",
                    completed.await(105, TimeUnit.SECONDS));
            JSONObject observation = new JSONObject(result.get());
            assertTrue("Packaged Hard Worker failed closed: " + observation, !observation.has("error"));
            assertTrue("Capacitor must serve this canary from the app HTTPS origin",
                    observation.getString("location").startsWith("https://localhost/"));
            assertTrue("Hard Worker URL must resolve from the packaged app origin",
                    observation.getString("workerUrl").startsWith("https://localhost/"));
            assertTrue("Factory must select the packaged Hard bundle", observation.getString("workerUrl")
                    .contains("MultiplayerHardAIWorker.bundle.mjs"));
            assertEquals("module", observation.getJSONObject("workerOptions").getString("type"));

            JSONObject request = observation.getJSONObject("request");
            JSONObject source = request.getJSONObject("serializedState");
            assertEquals("multiplayer", request.getString("strategy"));
            assertEquals("multiplayer-hard-v1", request.getString("modelId"));
            assertEquals(3, source.getInt("playerCount"));
            assertEquals(5, source.getInt("gridSize"));
            assertEquals("triangle", source.getString("boardShape"));
            assertEquals("territory-v3", source.getString("rulesVersion"));
            assertEquals(request.getString("aiPlayer"), source.getString("currentPlayer"));
            assertTrue("AI player must belong to the serialized active players",
                    contains(source.getJSONArray("activePlayers"), request.getString("aiPlayer")));

            JSONArray messages = observation.getJSONArray("messages");
            assertEquals("The first request must have exactly READY then RESULT", 2, messages.length());
            JSONObject ready = null;
            JSONObject answer = null;
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.getJSONObject(i);
                assertTrue("Only the expected Hard worker contract messages are accepted", 
                        "READY".equals(message.getString("type")) || "RESULT".equals(message.getString("type")));
                assertEquals(request.getString("requestId"), message.getString("requestId"));
                assertEquals(source.getInt("positionRevision"), message.getInt("positionRevision"));
                assertEquals("territory-v3", message.getString("rulesVersion"));
                assertEquals(request.getString("aiPlayer"), message.getString("currentPlayer"));
                assertEquals("multiplayer", message.getString("strategy"));
                assertEquals("multiplayer-hard-v1", message.getJSONObject("modelInfo").getString("id"));
                if ("READY".equals(message.getString("type"))) ready = message;
                if ("RESULT".equals(message.getString("type"))) answer = message;
            }
            assertNotNull("Worker must announce READY after loading its model", ready);
            assertNotNull("Worker must return a result", answer);
            assertTrue("The first Hard move must pass the product engine legality check", observation.getBoolean("legalMove"));
            assertNotNull("The first Hard move should be recorded", observation.getJSONObject("move").optJSONArray("point"));
            assertTrue("Worker cleanup must be observed after pausing the actual match", observation.getBoolean("terminated"));
            assertTrue("The actual local match must remain paused after cleanup", observation.getBoolean("aiDuelPaused"));
        }
    }

    private static boolean contains(JSONArray values, String expected) throws Exception {
        for (int i = 0; i < values.length(); i++) if (expected.equals(values.getString(i))) return true;
        return false;
    }
}
