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

/** Exercises the packaged Capacitor page and a native capability call in Android WebView. */
@RunWith(AndroidJUnit4.class)
public class LifelineWebViewStartupTest {

    private static final String STARTUP_PROBE = "(function(){"
            + "try{"
            + "if(globalThis.__lifelineAndroidTestResult){return globalThis.__lifelineAndroidTestResult;}"
            + "const app=document.getElementById('app');"
            + "const cap=globalThis.Capacitor;"
            + "const plugin=cap&&cap.Plugins&&cap.Plugins.LifelineCapabilities;"
            + "const appPlugin=cap&&cap.Plugins&&cap.Plugins.App;"
            + "if(document.readyState==='complete'&&app&&app.childElementCount>0&&plugin&&plugin.getCapabilities"
            + "&&appPlugin&&appPlugin.getInfo"
            + "&&!globalThis.__lifelineAndroidTestQuery){"
            + "globalThis.__lifelineAndroidTestQuery=true;"
            + "Promise.all([plugin.getCapabilities({schemaVersion:1}),appPlugin.getInfo()]).then(([value,appInfo])=>{"
            + "globalThis.__lifelineAndroidTestResult=JSON.stringify({"
            + "title:document.title,url:location.href,appChildren:app.childElementCount,"
            + "native:cap.isNativePlatform(),platform:cap.getPlatform(),capabilities:value,appInfo:appInfo});"
            + "}).catch(error=>{globalThis.__lifelineAndroidTestResult=JSON.stringify({error:String(error)});});"
            + "}"
            + "return globalThis.__lifelineAndroidTestResult||null;"
            + "}catch(error){return JSON.stringify({error:String(error)});}" 
            + "})()";

    @Test
    public void packagedPageStartsAndReportsNativeAndroidCapabilities() throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull("Capacitor bridge should be initialized", activity.getBridge());
                WebView webView = activity.getBridge().getWebView();
                assertNotNull("Capacitor should create its WebView", webView);
                long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(45);
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        if (completed.getCount() == 0) {
                            return;
                        }
                        if (System.currentTimeMillis() >= deadline) {
                            result.set("{\"error\":\"WebView startup or native capability query timed out\"}");
                            completed.countDown();
                            return;
                        }
                        webView.evaluateJavascript(STARTUP_PROBE, value -> {
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
            });

            assertTrue("Packaged WebView did not finish startup and native capability query",
                    completed.await(50, TimeUnit.SECONDS));
            JSONObject resultJson = new JSONObject(result.get());
            assertTrue("Web page or native bridge failed: " + resultJson, !resultJson.has("error"));
            assertTrue("The app root should have rendered content", resultJson.getInt("appChildren") > 0);
            assertTrue("Capacitor should serve the packaged page from its local HTTPS origin",
                    resultJson.getString("url").startsWith("https://localhost"));
            assertTrue("Capacitor should identify this as a native platform", resultJson.getBoolean("native"));
            assertEquals("android", resultJson.getString("platform"));
            JSONObject appInfo = resultJson.getJSONObject("appInfo");
            assertEquals("1.0.1", appInfo.getString("version"));
            assertEquals("2", appInfo.getString("build"));

            JSONObject capabilities = resultJson.getJSONObject("capabilities");
            assertEquals(1, capabilities.getInt("schemaVersion"));
            assertEquals("android", capabilities.getString("platform"));
            assertEquals("android-native", capabilities.getString("source"));
            JSONObject values = capabilities.getJSONObject("capabilities");
            assertCapability(values, "sessionStorage", "implemented", "native");
            assertCapability(values, "credentialStorage", "implemented", "native");
            assertCapability(values, "channelLogin", "not-implemented", "none");
            assertCapability(values, "realName", "not-implemented", "none");
        }
    }

    private static void assertCapability(JSONObject values, String name, String support, String implementation)
            throws Exception {
        JSONObject capability = values.getJSONObject(name);
        assertEquals(name, support, capability.getString("support"));
        assertEquals(name, implementation, capability.getString("implementation"));
    }
}
