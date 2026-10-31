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
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Verifies native session persistence using only the isolated task emulator and app data. */
@RunWith(AndroidJUnit4.class)
public class LifelineSessionPersistenceTest {

    private static final String SESSION_KEY = "lifeline-local-game-session-v1";
    private static final String CLEAR_KEY = "lifeline-local-game-session-cleared-v1";
    private static final String SESSION_ENVELOPE =
            "{\"format\":\"lifeline-local-session-envelope\",\"version\":1,"
                    + "\"revision\":987654321,\"state\":\"cleared\"}";
    private static final String APP_READY = "document.readyState==='complete'"
            + "&&document.getElementById('app')"
            + "&&document.getElementById('app').childElementCount>0"
            + "&&globalThis.Capacitor"
            + "&&globalThis.Capacitor.Plugins"
            + "&&globalThis.Capacitor.Plugins.LifelineStorage"
            + "&&globalThis.__LIFELINE_STORAGE_STATUS__";

    @Test
    public void nativeSessionRecordSurvivesActivityRecreation() throws Exception {
        String writeResultName = "__LIFELINE_L33B_WRITE_RESULT__";
        String reloadResultName = "__LIFELINE_L33B_RELOAD_RESULT__";
        String cleanupResultName = "__LIFELINE_L33B_CLEANUP_RESULT__";
        String keyJson = JSONObject.quote(SESSION_KEY);
        String clearKeyJson = JSONObject.quote(CLEAR_KEY);
        String envelopeJson = JSONObject.quote(SESSION_ENVELOPE);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            try {
                WebView initialWebView = webViewFrom(scenario);
                JSONObject written = awaitResult(initialWebView, writeResultName,
                        "(async function(){try{"
                                + "const plugin=globalThis.Capacitor.Plugins.LifelineStorage;"
                                + "await plugin.removeRecord({key:" + keyJson + "});"
                                + "localStorage.removeItem(" + keyJson + ");"
                                + "localStorage.removeItem(" + clearKeyJson + ");"
                                + "const saved=await plugin.saveRecord({key:" + keyJson + ",value:" + envelopeJson + "});"
                                + "const loaded=await plugin.loadRecord({key:" + keyJson + "});"
                                + "globalThis." + writeResultName + "=JSON.stringify({"
                                + "durable:saved&&saved.durable===true,value:loaded&&loaded.value});"
                                + "}catch(error){globalThis." + writeResultName
                                + "=JSON.stringify({error:String(error)});}})();");
                assertTrue("Native plugin did not confirm its session write: " + written,
                        written.getBoolean("durable"));
                assertEquals(SESSION_ENVELOPE, written.getString("value"));

                scenario.recreate();
                WebView recreatedWebView = webViewFrom(scenario);
                JSONObject restored = awaitResult(recreatedWebView, reloadResultName,
                        "(async function(){try{"
                                + "const plugin=globalThis.Capacitor.Plugins.LifelineStorage;"
                                + "const loaded=await plugin.loadRecord({key:" + keyJson + "});"
                                + "globalThis." + reloadResultName + "=JSON.stringify({"
                                + "nativeValue:loaded&&loaded.value,localValue:localStorage.getItem(" + keyJson + ")});"
                                + "}catch(error){globalThis." + reloadResultName
                                + "=JSON.stringify({error:String(error)});}})();");
                assertEquals(SESSION_ENVELOPE, restored.getString("nativeValue"));
                assertEquals("App startup should restore the envelope into local storage",
                        SESSION_ENVELOPE, restored.getString("localValue"));
            } finally {
                WebView cleanupWebView = webViewFrom(scenario);
                JSONObject cleaned = awaitResult(cleanupWebView, cleanupResultName,
                        "(async function(){try{"
                                + "const result=await globalThis.Capacitor.Plugins.LifelineStorage.removeRecord({key:"
                                + keyJson + "});"
                                + "localStorage.removeItem(" + keyJson + ");"
                                + "localStorage.removeItem(" + clearKeyJson + ");"
                                + "globalThis." + cleanupResultName + "=JSON.stringify({"
                                + "durable:result&&result.durable===true});"
                                + "}catch(error){globalThis." + cleanupResultName
                                + "=JSON.stringify({error:String(error)});}})();");
                assertTrue("Native plugin did not confirm test record cleanup: " + cleaned,
                        cleaned.getBoolean("durable"));
            }
        }
    }

    private static WebView webViewFrom(ActivityScenario<MainActivity> scenario) {
        AtomicReference<WebView> result = new AtomicReference<>();
        scenario.onActivity(activity -> {
            assertNotNull("Capacitor bridge should be initialized", activity.getBridge());
            result.set(activity.getBridge().getWebView());
        });
        assertNotNull("Capacitor should create its WebView", result.get());
        return result.get();
    }

    private static JSONObject awaitResult(WebView webView, String resultName, String triggerScript)
            throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(45);
        String startedName = resultName + "_STARTED";
        String probe = "(function(){try{"
                + "const plugin=globalThis.Capacitor&&globalThis.Capacitor.Plugins"
                + "&&globalThis.Capacitor.Plugins.LifelineStorage;"
                + "if((" + APP_READY + ")&&plugin&&!globalThis." + startedName + "){"
                + "globalThis." + startedName + "=true;" + triggerScript + "}"
                + "return globalThis." + resultName + "||null;"
                + "}catch(error){return JSON.stringify({error:String(error)});}})()";

        webView.post(new Runnable() {
            @Override
            public void run() {
                if (completed.getCount() == 0) return;
                if (System.currentTimeMillis() >= deadline) {
                    result.set("{\"error\":\"Timed out waiting for native session persistence result\"}");
                    completed.countDown();
                    return;
                }
                webView.evaluateJavascript(probe, value -> {
                    try {
                        Object decoded = new JSONTokener(value).nextValue();
                        if (decoded instanceof String && !((String) decoded).isEmpty()) {
                            result.set((String) decoded);
                            completed.countDown();
                        } else {
                            webView.postDelayed(this, 200);
                        }
                    } catch (Exception ignored) {
                        webView.postDelayed(this, 200);
                    }
                });
            }
        });

        assertTrue("Timed out waiting for packaged WebView startup and native session result",
                completed.await(47, TimeUnit.SECONDS));
        JSONObject decoded = new JSONObject(result.get());
        assertTrue("WebView session persistence probe failed: " + decoded, !decoded.has("error"));
        return decoded;
    }
}
