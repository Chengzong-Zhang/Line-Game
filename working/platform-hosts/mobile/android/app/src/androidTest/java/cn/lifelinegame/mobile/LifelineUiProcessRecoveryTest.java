package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;
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

/** L33-E r3 verifies visible match UI after force-stop and native-newer session authority. */
@RunWith(AndroidJUnit4.class)
public class LifelineUiProcessRecoveryTest {
    private static final String KEY = "lifeline-local-game-session-v1";
    private static final String CLEAR_KEY = "lifeline-local-game-session-cleared-v1";
    private static final String FORMAT = "lifeline-local-session-envelope";
    private static final String TOMBSTONE = "__LIFELINE_CLEARED_V1__";
    private static final String READY = "document.readyState==='complete'&&globalThis.Capacitor"
            + "&&globalThis.Capacitor.Plugins&&globalThis.Capacitor.Plugins.LifelineStorage";

    @Test public void prepareSavedSession() throws Exception {
        requirePhase("prepare");
        inPage("prepare", "(async()=>{try{"
                + "const deadline=Date.now()+30000;let writer=null;"
                + "while(Date.now()<deadline){writer=globalThis.__LIFELINE_MOBILE_SESSION_WRITER__;"
                + "if(document.querySelector('.game-canvas')&&writer?.writeSaved"
                + "&&globalThis.LifelinePlatform?.flushSessionMirror)break;"
                + "await new Promise(r=>setTimeout(r,150));}"
                + "if(!writer?.writeSaved||!globalThis.LifelinePlatform?.flushSessionMirror)"
                + "throw Error('product session writer or mirror flush unavailable');"
                + "await globalThis.LifelinePlatform.flushSessionMirror();"
                + "const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "const m=await import(new URL('/LocalGameSession.js',location.href).href);"
                + "const settings={playerCount:2,gridSize:6,startPlayer:'BLACK',"
                + "rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,"
                + "hintEnabled:true,hintMaxCount:3};"
                + "const context={aiMode:'none',aiDepth:2,aiStrategy:'minimax',aiModelVersion:'legacy',aiSeed:null,"
                + "aiDuelPaused:false,tutorialDismissed:true};"
                + "const localSession=m.createLocalGameSession(settings,[],context);"
                + "const nativeSession=m.createLocalGameSession(settings,[{type:'player_move',point:[1,0]}],context);"
                + "const localPayload=JSON.stringify(localSession),nativePayload=JSON.stringify(nativeSession);"
                + "const localParsed=m.parseLocalGameSessionRecord(localPayload);"
                + "const nativeParsed=m.parseLocalGameSessionRecord(nativePayload);"
                + "if(!localParsed||!nativeParsed||localParsed.actions.length!==0||nativeParsed.actions.length!==1"
                + "||localParsed.settings.startPlayer!=='BLACK'||nativeParsed.settings.startPlayer!=='BLACK'"
                + "||JSON.stringify(nativeParsed.actions[0]?.point)!=='[1,0]'"
                + "||localParsed.playContext?.tutorialDismissed!==true||nativeParsed.playContext?.tutorialDismissed!==true)"
                + "throw Error('A/B local/native fixture parser or turn/action assertions failed');"
                + "const localValue=writer.writeSaved(localPayload);"
                + "if(typeof localValue!=='string'||!localValue)throw Error('product writer rejected fixture');"
                + "const localEnvelope=JSON.parse(localValue);"
                + "if(localEnvelope.format!==" + JSONObject.quote(FORMAT) + "||localEnvelope.revision!==1||localEnvelope.state!=='saved')"
                + "throw Error('product writer did not create the expected revision-1 saved envelope');"
                + "await globalThis.LifelinePlatform.flushSessionMirror();"
                + "const nativeV1=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;"
                + "if(nativeV1!==localValue||localStorage.getItem(" + JSONObject.quote(KEY) + ")!==localValue)"
                + "throw Error('product writer revision-1 local/native copies did not match after durable flush');"
                + "const nativeV2=JSON.stringify({...localEnvelope,revision:2,payload:nativePayload});"
                + "const saved=await p.saveRecord({key:" + JSONObject.quote(KEY) + ",value:nativeV2});"
                + "if(saved?.durable!==true)throw Error('native revision-2 promotion was not confirmed durable');"
                + "const nativeReadback=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;"
                + "const localAfter=localStorage.getItem(" + JSONObject.quote(KEY) + ");"
                + "const nativeEnvelope=typeof nativeReadback==='string'?JSON.parse(nativeReadback):null;"
                + "const localAfterEnvelope=typeof localAfter==='string'?JSON.parse(localAfter):null;"
                + "await new Promise(r=>setTimeout(r,250));"
                + "const localFinal=localStorage.getItem(" + JSONObject.quote(KEY) + ");"
                + "const nativeFinal=(await p.loadRecord({key:" + JSONObject.quote(KEY) + "}))?.value??null;"
                + "if(nativeFinal!==nativeV2||localFinal!==localValue||nativeEnvelope?.revision!==2||localAfterEnvelope?.revision!==1"
                + "||nativeEnvelope?.payload!==nativePayload||localAfterEnvelope?.payload!==localPayload)"
                + "throw Error('revision-2 native authority readback, local revision-1 preservation, or settled mirror check failed');"
                + "return {phase:'prepare',durable:true,nativeRevision1Matched:nativeV1===localValue,"
                + "localValue:localFinal,nativeValue:nativeFinal,localRevision:localAfterEnvelope.revision,"
                + "nativeRevision:nativeEnvelope.revision,nativePreferred:nativeEnvelope.revision>localAfterEnvelope.revision,"
                + "localActions:localParsed.actions.length,nativeActions:nativeParsed.actions.length,"
                + "localStartPlayer:localParsed.settings.startPlayer,nativeStartPlayer:nativeParsed.settings.startPlayer,"
                + "nativeActionType:nativeParsed.actions[0]?.type,nativeActionPoint:nativeParsed.actions[0]?.point,"
                + "localTutorialDismissed:localParsed.playContext.tutorialDismissed,"
                + "nativeTutorialDismissed:nativeParsed.playContext.tutorialDismissed};"
                + "}catch(error){throw Error(String(error));}})()");
    }

    @Test public void verifyColdStartVisibleMatchUi() throws Exception {
        requirePhase("verify");
        verifyVisibleMatchUi("(async()=>{"
                + "const expectedSha=" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("expectedNativeSha256", "")) + ";"
                + "const expectedRevision=Number(" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("expectedNativeRevision", "")) + ");"
                + "const runToken=" + JSONObject.quote(InstrumentationRegistry.getArguments().getString("runToken", "")) + ";"
                + "const diag={phase:'verify',expectedNativeSha256:expectedSha,expectedNativeRevision:expectedRevision,runToken,"
                + "visibleMatchUiObserved:false,laidOutCanvas:false,redBanner:false,resumeNoticeMatches:false,"
                + "restoredActionCount:null,recoveryRoute:'unavailable',localRevision:null,nativeRevision:null,"
                + "localValue:null,nativeValue:null,localNativeEqual:false,localActions:null,nativeActions:null,"
                + "localTutorialDismissed:null,nativeTutorialDismissed:null,storageStatus:null,turn:null,bannerClass:null,"
                + "resumeNotice:null,canvasCssWidth:null,canvasCssHeight:null,canvasPixelWidth:null,canvasPixelHeight:null,nativeAuthorityReady:false,errors:[]};"
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
                + "const redBanner=!!(turn&&banner?.classList.contains('is-red'));"
                + "const localActions=local?.session?.actions?.length??null;"
                + "const nativeActions=native?.session?.actions?.length??null;"
                + "const localActionPoint=local?.session?.actions?.[0]?.point??null;"
                + "const nativeActionPoint=native?.session?.actions?.[0]?.point??null;"
                + "const broadUi=!!(laidOutCanvas&&redBanner&&localActions===1&&JSON.stringify(localActionPoint)==='[1,0]');"
                + "const recoveryRoute=storageStatus?.state==='restored'&&storageStatus?.source==='native'&&storageStatus?.operation==='restore'?'native-restore':"
                + "storageStatus?.state==='confirmed'&&storageStatus?.source==='local'&&storageStatus?.operation==='load'?'local-load':'unclassified';"
                + "const localSha=await digest(localValue),nativeSha=await digest(nativeValue);"
                + "const nativeAuthorityReady=!!(storageStatus?.state==='restored'&&storageStatus?.source==='native'&&storageStatus?.operation==='restore'"
                + "&&storageStatus?.nativeAvailable===true&&resumeNoticeMatches&&recoveryRoute==='native-restore'"
                + "&&local&&native&&localValue===nativeValue&&local.revision===expectedRevision&&native.revision===expectedRevision"
                + "&&localSha===expectedSha&&nativeSha===expectedSha&&localActions===1&&nativeActions===1"
                + "&&JSON.stringify(localActionPoint)==='[1,0]'&&JSON.stringify(nativeActionPoint)==='[1,0]'"
                + "&&local.session.playContext?.tutorialDismissed===true&&native.session.playContext?.tutorialDismissed===true);"
                + "Object.assign(diag,{visibleMatchUiObserved:broadUi,laidOutCanvas,redBanner,resumeNoticeMatches,nativeAuthorityReady,"
                + "restoredActionCount:localActions,recoveryRoute,localRevision:local?.revision??null,nativeRevision:native?.revision??null,"
                + "localValue,nativeValue,localSha256:localSha,nativeSha256:nativeSha,localNativeEqual:typeof localValue==='string'&&localValue===nativeValue,"
                + "localActions,nativeActions,localActionType:local?.session?.actions?.[0]?.type??null,"
                + "localActionPoint,nativeActionType:native?.session?.actions?.[0]?.type??null,nativeActionPoint,"
                + "localTutorialDismissed:local?.session?.playContext?.tutorialDismissed??null,"
                + "nativeTutorialDismissed:native?.session?.playContext?.tutorialDismissed??null,storageStatus,turn,bannerClass:banner?.className||null,resumeNotice:noticeText,"
                + "canvasCssWidth:rect?.width??null,canvasCssHeight:rect?.height??null,canvasPixelWidth:canvas?.width??null,canvasPixelHeight:canvas?.height??null});"
                + "if(broadUi&&nativeAuthorityReady)break;"
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
        bundle.putString("l33e_verify_observation", observation.toString());
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
        assertTrue("Red turn banner was not observed: " + observation, observation.optBoolean("redBanner"));
        assertTrue("Restore notice did not match: " + observation, observation.optBoolean("resumeNoticeMatches"));
        assertTrue("Native authority restore gates were not all observed: " + observation, observation.optBoolean("nativeAuthorityReady"));
        assertEquals("Expected one restored move", 1, observation.optInt("restoredActionCount", -1));
        assertEquals("Expected native-restore route", "native-restore", observation.optString("recoveryRoute"));
        assertEquals("Expected local/native equality", true, observation.optBoolean("localNativeEqual"));
        assertEquals("Expected local revision 2", observation.optLong("expectedNativeRevision", -1), observation.optLong("localRevision", -2));
        assertEquals("Expected native revision 2", observation.optLong("expectedNativeRevision", -1), observation.optLong("nativeRevision", -2));
        assertTrue("Local copy does not match prepared native revision-2 SHA256: " + observation, observation.optBoolean("localMatchesExpected"));
        assertTrue("Native copy does not match prepared revision-2 SHA256: " + observation, observation.optBoolean("nativeMatchesExpected"));
        assertEquals("Expected one action in native copy", 1, observation.optInt("nativeActions", -1));
        assertEquals("Expected restored move type", "player_move", observation.optString("localActionType"));
        assertEquals("Expected native move type", "player_move", observation.optString("nativeActionType"));
        assertEquals("Expected restored move coordinate", "[1,0]", observation.optJSONArray("localActionPoint").toString());
        assertEquals("Expected native move coordinate", "[1,0]", observation.optJSONArray("nativeActionPoint").toString());
        assertTrue("Local tutorial state was not preserved: " + observation, observation.optBoolean("localTutorialDismissed"));
        assertTrue("Native tutorial state was not preserved: " + observation, observation.optBoolean("nativeTutorialDismissed"));
        assertEquals("Expected prepare token to reach verify", InstrumentationRegistry.getArguments().getString("runToken", ""), observation.optString("runToken"));
        JSONObject status = observation.optJSONObject("storageStatus");
        assertNotNull("Missing storage recovery status: " + observation, status);
        assertEquals("Expected restored storage status", "restored", status.getString("state"));
        assertEquals("Expected native recovery source", "native", status.getString("source"));
        assertEquals("Expected restore operation", "restore", status.getString("operation"));
        assertTrue("Native storage was not available: " + observation, status.getBoolean("nativeAvailable"));
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
                assertTrue(result.getBoolean("nativeRevision1Matched"));
                assertEquals(1, result.getInt("localRevision"));
                assertEquals(2, result.getInt("nativeRevision"));
                assertTrue(result.getBoolean("nativePreferred"));
                assertEquals(0, result.getInt("localActions"));
                assertEquals(1, result.getInt("nativeActions"));
                assertEquals("BLACK", result.getString("localStartPlayer"));
                assertEquals("BLACK", result.getString("nativeStartPlayer"));
                assertEquals("player_move", result.getString("nativeActionType"));
                assertEquals("[1,0]", result.getJSONArray("nativeActionPoint").toString());
                assertTrue(result.getBoolean("localTutorialDismissed"));
                assertTrue(result.getBoolean("nativeTutorialDismissed"));
                String localSha256 = sha256(result.getString("localValue"));
                String nativeSha256 = sha256(result.getString("nativeValue"));
                assertTrue("Malformed prepare SHA256", localSha256.matches("^[0-9a-f]{64}$") && nativeSha256.matches("^[0-9a-f]{64}$"));
                assertTrue("A and B envelope hashes must differ", !localSha256.equals(nativeSha256));
                JSONObject ready = new JSONObject();
                ready.put("phase", "prepare");
                ready.put("durable", true);
                ready.put("localRevision", 1);
                ready.put("nativeRevision", 2);
                ready.put("nativePreferred", true);
                ready.put("localSha256", localSha256);
                ready.put("nativeSha256", nativeSha256);
                ready.put("nativeRevision1Matched", result.getBoolean("nativeRevision1Matched"));
                ready.put("localActions", 0);
                ready.put("nativeActions", 1);
                ready.put("localStartPlayer", "BLACK");
                ready.put("nativeStartPlayer", "BLACK");
                ready.put("nativeActionType", "player_move");
                ready.put("nativeActionPoint", result.getJSONArray("nativeActionPoint"));
                ready.put("localTutorialDismissed", true);
                ready.put("nativeTutorialDismissed", true);
                String runToken = InstrumentationRegistry.getArguments().getString("runToken", "");
                assertTrue("Missing L33-E run token", !runToken.trim().isEmpty());
                ready.put("runToken", runToken);
                ready.put("inProcessPid", result.getInt("inProcessPid"));
                ready.put("holdState", "awaiting-external-force-stop");
                Bundle bundle = new Bundle();
                bundle.putString("l33e_prepare_ready", ready.toString());
                InstrumentationRegistry.getInstrumentation().sendStatus(2, bundle);
                assertTrue("Timed out waiting for external L33-E force-stop",
                        new CountDownLatch(1).await(120, TimeUnit.SECONDS));
            } else {
                assertTrue(result.getBoolean("durable"));
                assertTrue(result.getBoolean("markersRemoved"));
                assertEquals(TOMBSTONE, result.getString("tombstone"));
                Bundle observation = new Bundle();
                observation.putString("l33e_cleanup_observation", result.toString());
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
        assertTrue("L33-E " + name + " failed: " + result, !result.has("error"));
        return result.toString();
    }

    private static String awaitRaw(WebView webView, String name, String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(45);
        String started = "__L33E_STARTED_" + name;
        String resultName = "__L33E_RESULT_" + name;
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
