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

/** Bounded canary for the packaged module TerritoryWorker in the real Capacitor WebView. */
@RunWith(AndroidJUnit4.class)
public class LifelineTerritoryWorkerCanaryTest {

    private static final String WORKER_CANARY = "(function(){"
            + "try{"
            + "if(globalThis.__lifelineTerritoryCanary)return globalThis.__lifelineTerritoryCanary;"
            + "const workerUrl=new URL('TerritoryWorker.js',location.href).href;"
            + "const worker=new Worker(workerUrl,{type:'module'});"
            + "const requestId='l33-c-canary-1';"
            + "const serializedState={gridSize:5,playerCount:2,boardShape:'triangle',startPlayer:'BLACK',"
            + "rulesVersion:'territory-v2',positionRevision:7,activePlayers:['BLACK','WHITE'],gridEntries:[],"
            + "edges:{BLACK:[],WHITE:[]},edgesBlack:[],edgesWhite:[],edgesPurple:[],historyHashes:[],"
            + "consecutiveSkips:0,resignedPlayers:[],currentPlayer:'BLACK',gameOver:false,turnCount:0};"
            + "let done=false;const finish=value=>{if(done)return;done=true;worker.terminate();"
            + "globalThis.__lifelineTerritoryCanary=JSON.stringify({...value,workerUrl,terminated:true});};"
            + "worker.onmessage=event=>finish(event.data);"
            + "worker.onerror=event=>finish({type:'WORKER_ERROR',message:String(event.message||event)});"
            + "setTimeout(()=>finish({type:'TIMEOUT',message:'TerritoryWorker exceeded 20 second canary deadline'}),20000);"
            + "worker.postMessage({type:'COMPUTE_TERRITORIES',requestId,territoryStateRevision:11,"
            + "gameOver:false,serializedState});return null;"
            + "}catch(error){return JSON.stringify({type:'SETUP_ERROR',message:String(error)});}"
            + "})()";

    @Test
    public void packagedModuleWorkerReturnsRevisionBoundTerritories() throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull("Capacitor bridge should be initialized", activity.getBridge());
                WebView webView = activity.getBridge().getWebView();
                assertNotNull("Capacitor should create its WebView", webView);
                long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(35);
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        if (completed.getCount() == 0) return;
                        if (System.currentTimeMillis() >= deadline) {
                            result.set("{\"type\":\"JAVA_TIMEOUT\"}");
                            completed.countDown();
                            return;
                        }
                        webView.evaluateJavascript(WORKER_CANARY, value -> {
                            try {
                                Object decoded = new JSONTokener(value).nextValue();
                                if (decoded instanceof String && !((String) decoded).isEmpty()) {
                                    result.set((String) decoded);
                                    completed.countDown();
                                } else {
                                    webView.postDelayed(this, 100);
                                }
                            } catch (Exception ignored) {
                                webView.postDelayed(this, 100);
                            }
                        });
                    }
                });
            });

            assertTrue("Packaged module Worker did not finish within the hard deadline",
                    completed.await(40, TimeUnit.SECONDS));
            JSONObject response = new JSONObject(result.get());
            assertEquals("TerritoryWorker response: " + response, "RESULT", response.getString("type"));
            assertEquals("l33-c-canary-1", response.getString("requestId"));
            assertEquals(7, response.getInt("positionRevision"));
            assertEquals("territory-v2", response.getString("rulesVersion"));
            assertEquals("BLACK", response.getString("currentPlayer"));
            assertEquals(11, response.getInt("territoryStateRevision"));
            assertTrue("Worker should be terminated after the first response", response.getBoolean("terminated"));
            assertTrue("Worker must resolve from the packaged app origin",
                    response.getString("workerUrl").startsWith("https://localhost/"));
            JSONObject territories = response.getJSONObject("territories");
            assertFiniteBoundedArea(territories.getJSONObject("BLACK").getDouble("area"));
            assertFiniteBoundedArea(territories.getJSONObject("WHITE").getDouble("area"));
        }
    }

    private static void assertFiniteBoundedArea(double area) {
        assertTrue("Area must be finite and within the 5x5 board", Double.isFinite(area) && area >= 0 && area <= 25);
    }
}
