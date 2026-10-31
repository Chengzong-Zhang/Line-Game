package cn.lifelinegame.mobile;

import android.view.HapticFeedbackConstants;
import android.view.View;
import android.webkit.WebView;
import android.webkit.RenderProcessGoneDetail;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LifelineHaptics")
public final class LifelineHapticsPlugin extends Plugin {
    private static final long MAX_DISPATCH_AGE_MS = 350;
    private final Object lock = new Object();
    private boolean foreground = true;
    private boolean pageReady;
    private boolean destroyed;
    private boolean inFlight;
    private long pageGeneration;
    private WebViewListener webViewListener;

    @Override
    public void load() {
        super.load();
        webViewListener = new WebViewListener() {
            @Override public void onPageStarted(WebView webView) {
                synchronized (lock) { pageGeneration++; pageReady = false; }
            }
            @Override public void onPageLoaded(WebView webView) {
                synchronized (lock) { pageReady = true; }
            }
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                synchronized (lock) { pageGeneration++; pageReady = false; }
                return false;
            }
        };
        if (getBridge() != null) getBridge().addWebViewListener(webViewListener);
    }

    @PluginMethod
    public void requestMoveHaptic(PluginCall call) {
        final long acceptedAt = SystemClock.uptimeMillis();
        final long requestGeneration;
        synchronized (lock) {
            if (destroyed || !foreground || !pageReady || inFlight) { resolve(call, "suppressed"); return; }
            inFlight = true;
            requestGeneration = pageGeneration;
        }
        try {
            getActivity().runOnUiThread(() -> {
                boolean accepted = false;
                try {
                    synchronized (lock) {
                        if (destroyed || !foreground || !pageReady || pageGeneration != requestGeneration
                                || SystemClock.uptimeMillis() - acceptedAt > MAX_DISPATCH_AGE_MS) return;
                    }
                    if (getActivity().isFinishing() || getActivity().isDestroyed()) return;
                    WebView webView = getBridge() == null ? null : getBridge().getWebView();
                    if (webView == null || !webView.isAttachedToWindow() || !webView.isShown()
                            || !webView.hasWindowFocus() || !webView.isEnabled()) return;
                    accepted = webView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                } catch (RuntimeException ignored) {
                    accepted = false;
                } finally {
                    synchronized (lock) { inFlight = false; }
                    resolve(call, accepted ? "requested" : "suppressed");
                }
            });
        } catch (RuntimeException ignored) {
            synchronized (lock) { inFlight = false; }
            resolve(call, "suppressed");
        }
    }

    @Override
    public void handleOnPause() { synchronized (lock) { foreground = false; pageGeneration++; } }

    @Override
    public void handleOnResume() { synchronized (lock) { foreground = true; } }

    @Override
    public void handleOnDestroy() {
        synchronized (lock) { destroyed = true; pageGeneration++; pageReady = false; }
        if (webViewListener != null && getBridge() != null) getBridge().removeWebViewListener(webViewListener);
    }

    private static void resolve(PluginCall call, String status) {
        JSObject result = new JSObject();
        result.put("status", status);
        call.resolve(result);
    }
}
