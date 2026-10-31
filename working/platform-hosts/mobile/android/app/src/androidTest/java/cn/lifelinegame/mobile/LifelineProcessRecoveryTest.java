package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Two-phase cold-start fixture checks; the PowerShell runner kills the app between phases. */
@RunWith(AndroidJUnit4.class)
public class LifelineProcessRecoveryTest {
    private static final String KEY = "lifeline-local-game-session-v1";
    private static final String CLEAR_KEY = "lifeline-local-game-session-cleared-v1";
    private static final String TOMBSTONE = "__LIFELINE_CLEARED_V1__";
    private static final String READY = "document.readyState==='complete'&&globalThis.Capacitor"
            + "&&globalThis.Capacitor.Plugins&&globalThis.Capacitor.Plugins.LifelineStorage";

    @Test public void prepareSavedSession() throws Exception {
        requirePhase("prepare");
        inPage("prepare", "(async()=>{try{"
                + "const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "await p.removeRecord({key:" + JSONObject.quote(KEY) + "});"
                + "localStorage.removeItem(" + JSONObject.quote(KEY) + ");"
                + "localStorage.removeItem(" + JSONObject.quote(CLEAR_KEY) + ");"
                + "const m=await import(new URL('/LocalGameSession.js',location.href).href);"
                + "const e=await import(new URL('/platform/session-envelope.js',location.href).href);"
                + "const session=m.createLocalGameSession({playerCount:2,gridSize:6,startPlayer:'BLACK',"
                + "rulesVersion:'territory-v2',turnTimerEnabled:false,turnTimeLimitSeconds:60,"
                + "hintEnabled:true,hintMaxCount:3},[{type:'player_move',point:[1,0]}]);"
                + "const payload=JSON.stringify(session);"
                + "if(!m.parseLocalGameSessionRecord(payload))throw Error('fixture parser rejected session');"
                + "const value=e.serializeSessionEnvelope({revision:987654321,state:'saved',payload});"
                + "const saved=await p.saveRecord({key:" + JSONObject.quote(KEY) + ",value});"
                + "const loaded=await p.loadRecord({key:" + JSONObject.quote(KEY) + "});"
                + "if(saved?.durable!==true||loaded?.value!==value)throw Error('native save/readback mismatch');"
                + "return {phase:'prepare',durable:saved.durable,value,session:JSON.parse(payload)};"
                + "}catch(error){throw Error(String(error));}})()");
    }

    @Test public void verifyColdStartStorageAndSessionParser() throws Exception {
        requirePhase("verify");
        inPage("verify", "(async()=>{try{"
                + "const p=globalThis.Capacitor.Plugins.LifelineStorage;"
                + "const loaded=await p.loadRecord({key:" + JSONObject.quote(KEY) + "});"
                + "const local=localStorage.getItem(" + JSONObject.quote(KEY) + ");"
                + "const m=await import(new URL('/LocalGameSession.js',location.href).href);"
                + "const valid=Boolean(loaded?.value&&m.parseLocalGameSessionRecord(loaded.value));"
                + "if(!valid||local!==loaded.value)throw Error('native/local/parser recovery mismatch');"
                + "return {phase:'verify',nativeValue:loaded.value,localValue:local,parserAccepted:valid,"
                + "uiRestoreObserved:false,scope:'storage-plus-parser'};"
                + "}catch(error){throw Error(String(error));}})()");
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

    private static void requirePhase(String expected) {
        String phase = InstrumentationRegistry.getArguments().getString("phase", "");
        Assume.assumeTrue("Run with instrumentation argument phase=" + expected, expected.equals(phase));
    }

    private static void inPage(String resultName, String expression) throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<WebView> reference = new AtomicReference<>();
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge());
                reference.set(activity.getBridge().getWebView());
            });
            WebView webView = reference.get();
            assertNotNull(webView);
            String output = await(webView, resultName, expression);
            JSONObject result = new JSONObject(output);
            assertEquals(resultName, result.getString("phase"));
            if ("prepare".equals(resultName)) {
                assertTrue(result.getBoolean("durable"));
                assertTrue(result.getJSONObject("session").getJSONArray("actions").length() == 1);
            } else if ("verify".equals(resultName)) {
                assertTrue(result.getBoolean("parserAccepted"));
                assertEquals(result.getString("nativeValue"), result.getString("localValue"));
                assertEquals("storage-plus-parser", result.getString("scope"));
            } else {
                assertTrue(result.getBoolean("durable"));
                assertTrue(result.getBoolean("markersRemoved"));
                assertEquals(TOMBSTONE, result.getString("tombstone"));
            }
        }
    }

    private static String await(WebView webView, String resultName, String expression) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch complete = new CountDownLatch(1);
        long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(35);
        String startedName = "__L33D_STARTED_" + resultName;
        String resultGlobalName = "__L33D_RESULT_" + resultName;
        String probe = "(function(){try{if((" + READY + ")&&!globalThis["
                + JSONObject.quote(startedName) + "]){globalThis[" + JSONObject.quote(startedName) + "]=true;"
                + "Promise.resolve(" + expression + ").then(v=>{globalThis["
                + JSONObject.quote(resultGlobalName) + "]=JSON.stringify(v);},e=>{globalThis["
                + JSONObject.quote(resultGlobalName) + "]=JSON.stringify({error:String(e)});});}"
                + "return globalThis[" + JSONObject.quote(resultGlobalName)
                + "]||null;}catch(e){return JSON.stringify({error:String(e)});}})()";
        webView.post(new Runnable() {
            @Override public void run() {
                if (complete.getCount() == 0) return;
                if (System.currentTimeMillis() >= deadline) {
                    result.set("{\"error\":\"phase probe timed out\"}"); complete.countDown(); return;
                }
                webView.evaluateJavascript(probe, value -> {
                    try {
                        Object decoded = new JSONTokener(value).nextValue();
                        if (decoded instanceof String && !((String) decoded).isEmpty()) {
                            result.set((String) decoded); complete.countDown();
                        } else webView.postDelayed(this, 200);
                    } catch (Exception ignored) { webView.postDelayed(this, 200); }
                });
            }
        });
        assertTrue("Timed out waiting for L33-D " + resultName, complete.await(37, TimeUnit.SECONDS));
        JSONObject decoded = new JSONObject(result.get());
        assertTrue("L33-D " + resultName + " failed: " + decoded, !decoded.has("error"));
        return decoded.toString();
    }
}
