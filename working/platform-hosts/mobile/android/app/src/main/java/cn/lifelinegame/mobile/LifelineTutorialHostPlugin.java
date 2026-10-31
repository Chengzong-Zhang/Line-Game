package cn.lifelinegame.mobile;

import android.app.Dialog;
import android.graphics.Color;
import android.net.Uri;
import android.view.Gravity;
import android.view.ViewGroup;
import android.os.Handler;
import android.os.Looper;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.View;

import androidx.webkit.WebViewAssetLoader;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(name = "LifelineTutorialHost")
public final class LifelineTutorialHostPlugin extends Plugin {
    private enum HostState { CLOSED, OPENING, OPEN, CLOSING }

    private static final class TutorialSession {
        final long generation;
        final WebView webView;
        final Dialog dialog;
        boolean released;

        TutorialSession(long generation, WebView webView, Dialog dialog) {
            this.generation = generation;
            this.webView = webView;
            this.dialog = dialog;
        }
    }

    private final Object lock = new Object();
    private WebViewListener mainListener;
    private HostState hostState = HostState.CLOSED;
    private TutorialSession tutorialSession;
    private long tutorialGeneration;
    private long rendererGoneGeneration = -1;
    private long tutorialOwnerPageGeneration = -1;
    private String openUrl;
    private long mainPageGeneration;
    private boolean mainPageReady;
    private boolean destroyed;

    @Override
    public void load() {
        super.load();
        mainListener = new WebViewListener() {
            @Override public void onPageStarted(WebView webView) {
                synchronized (lock) { mainPageGeneration++; mainPageReady = false; }
                closeTutorial();
            }
            @Override public void onPageLoaded(WebView webView) {
                synchronized (lock) { mainPageReady = true; }
            }
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                synchronized (lock) { mainPageGeneration++; mainPageReady = false; }
                closeTutorial();
                return false;
            }
        };
        if (getBridge() != null) getBridge().addWebViewListener(mainListener);
    }

    @PluginMethod
    public void openTutorial(PluginCall call) {
        String target = call.getString("url", "");
        if (!isAllowedTarget(target)) {
            call.reject("Only a same-origin tutorial URL may be opened.", "invalid-tutorial-url");
            return;
        }
        final long pageGeneration;
        final long generation;
        synchronized (lock) {
            if (destroyed || !mainPageReady || getBridge() == null || getBridge().getWebView() == null) {
                call.reject("The online page is no longer available.", "host-unavailable");
                return;
            }
            if (hostState == HostState.OPEN) {
                if (target.equals(openUrl)) resolveOpened(call);
                else call.reject("A different tutorial page is already open.", "already-open");
                return;
            }
            if (hostState == HostState.OPENING) {
                call.reject("The tutorial host is already opening.", "host-busy");
                return;
            }
            if (hostState == HostState.CLOSING) {
                call.reject("The tutorial host is closing.", "host-busy");
                return;
            }
            pageGeneration = mainPageGeneration;
            generation = ++tutorialGeneration;
            tutorialOwnerPageGeneration = pageGeneration;
            hostState = HostState.OPENING;
            openUrl = target;
        }
        android.app.Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            synchronized (lock) {
                if (generation == tutorialGeneration && hostState == HostState.OPENING) {
                    tutorialGeneration++;
                    hostState = HostState.CLOSED;
                    openUrl = null;
                    tutorialOwnerPageGeneration = -1;
                }
            }
            call.reject("The online page is no longer available.", "host-unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            synchronized (lock) {
                if (destroyed || generation != tutorialGeneration || pageGeneration != mainPageGeneration
                        || tutorialOwnerPageGeneration != pageGeneration || !mainPageReady || hostState != HostState.OPENING) {
                    if (generation == tutorialGeneration && hostState == HostState.OPENING) {
                        hostState = HostState.CLOSED;
                        openUrl = null;
                        tutorialOwnerPageGeneration = -1;
                    }
                    call.reject("The online page changed before the tutorial could open.", "stale-request");
                    return;
                }
            }
            try {
                showTutorial(target, generation);
                resolveOpened(call);
            } catch (RuntimeException error) {
                closeTutorial(generation, false);
                call.reject("The tutorial page could not be opened.", "host-failed");
            }
        });
    }

    private static boolean isAllowedTarget(String target) {
        try {
            Uri uri = Uri.parse(target);
            return uri.isHierarchical() && "https".equals(uri.getScheme())
                    && "localhost".equals(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443)
                    && uri.getUserInfo() == null && ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath()))
                    && uri.getFragment() == null && uri.getQueryParameterNames().size() == 1
                    && uri.getQueryParameters("tutorial").size() == 1
                    && "1".equals(uri.getQueryParameter("tutorial"));
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void showTutorial(String target, long generation) {
        android.app.Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) throw new IllegalStateException("Activity unavailable.");
        WebView webView = new WebView(activity);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setBlockNetworkLoads(true);
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("localhost")
                .addPathHandler("/", path -> openBundledAsset(activity, path))
                .build();
        TextView loadError = new TextView(activity);
        loadError.setText("教学页加载失败 / Tutorial page failed to load. 请关闭后重试 / Close and retry.");
        loadError.setTextColor(Color.rgb(180, 35, 24));
        loadError.setVisibility(View.GONE);
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!isTrustedOrigin(uri)) return blockedResponse();
                if (isTutorialDocument(uri)) return openTutorialDocument(activity);
                return assetLoader.shouldInterceptRequest(uri);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAllowedTarget(request.getUrl().toString());
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                closeTutorial(generation, true);
                return true;
            }
            @Override public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                    android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) loadError.setVisibility(View.VISIBLE);
            }
        });

        LinearLayout shell = new LinearLayout(activity);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.WHITE);
        shell.addView(loadError, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        Button close = new Button(activity);
        close.setText("完成教学 / Close tutorial");
        close.setOnClickListener(view -> closeTutorial());
        shell.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        shell.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        Dialog dialog = new Dialog(activity);
        TutorialSession session = new TutorialSession(generation, webView, dialog);
        dialog.setContentView(shell);
        dialog.setOnDismissListener(ignored -> releaseTutorial(session, false));
        boolean accepted;
        synchronized (lock) {
            accepted = !destroyed && generation == tutorialGeneration && hostState == HostState.OPENING;
            if (accepted) tutorialSession = session;
        }
        if (!accepted) {
            detachAndDestroyUnregistered(webView, dialog);
            throw new IllegalStateException("Tutorial open was superseded.");
        }
        dialog.show();
        synchronized (lock) {
            if (generation != tutorialGeneration || tutorialSession != session || hostState != HostState.OPENING) {
                throw new IllegalStateException("Tutorial host changed while opening.");
            }
            hostState = HostState.OPEN;
        }
        if (dialog.getWindow() != null) {
            dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            dialog.getWindow().setGravity(Gravity.CENTER);
        }
        webView.loadUrl(target);
    }

    private WebResourceResponse openBundledAsset(android.app.Activity activity, String path) {
        String normalized = path == null || path.isEmpty() ? "index.html" : path;
        if (normalized.startsWith("/") || normalized.contains("\\") || normalized.contains("..")) return blockedResponse();
        try {
            String mime = mimeType(normalized);
            return new WebResourceResponse(mime, "UTF-8", activity.getAssets().open("public/" + normalized));
        } catch (IOException error) {
            return blockedResponse();
        }
    }

    private static boolean isTutorialDocument(Uri uri) {
        return ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath()))
                && uri.getQueryParameterNames().size() == 1
                && uri.getQueryParameters("tutorial").size() == 1
                && "1".equals(uri.getQueryParameter("tutorial"));
    }

    private WebResourceResponse openTutorialDocument(android.app.Activity activity) {
        try (InputStream input = activity.getAssets().open("public/index.html");
                ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            String html = output.toString("UTF-8");
            String lowerHtml = html.toLowerCase(java.util.Locale.ROOT);
            int headStart = lowerHtml.indexOf("<head");
            int headEnd = headStart < 0 ? -1 : lowerHtml.indexOf('>', headStart);
            if (headEnd < 0) return blockedResponse();
            String policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'none'\">";
            html = html.substring(0, headEnd + 1) + policy + html.substring(headEnd + 1);
            return new WebResourceResponse("text/html", "UTF-8",
                    new java.io.ByteArrayInputStream(html.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (IOException error) {
            return blockedResponse();
        }
    }

    private static WebResourceResponse blockedResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static boolean isTrustedOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    private static String mimeType(String path) {
        String lower = path.toLowerCase(java.util.Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    private void closeTutorial() {
        closeTutorial(-1, false);
    }

    private void closeTutorial(long expectedGeneration, boolean rendererGone) {
        final long closingGeneration;
        final boolean rendererGoneForSession;
        synchronized (lock) {
            if (expectedGeneration >= 0 && expectedGeneration != tutorialGeneration) return;
            if (rendererGone) rendererGoneGeneration = tutorialGeneration;
            if (hostState == HostState.CLOSED || hostState == HostState.CLOSING) return;
            hostState = HostState.CLOSING;
            closingGeneration = tutorialGeneration;
            rendererGoneForSession = rendererGone || rendererGoneGeneration == closingGeneration;
        }
        android.app.Activity activity = getActivity();
        Runnable release = () -> releaseTutorialGeneration(closingGeneration, rendererGoneForSession);
        if (activity != null) activity.runOnUiThread(release);
        else new Handler(Looper.getMainLooper()).post(release);
    }

    private void releaseTutorialGeneration(long generation, boolean rendererGone) {
        TutorialSession session;
        boolean rendererGoneForSession;
        synchronized (lock) {
            if (generation != tutorialGeneration) return;
            rendererGoneForSession = rendererGone || rendererGoneGeneration == generation;
            session = tutorialSession;
            if (session == null) {
                hostState = HostState.CLOSED;
                openUrl = null;
                tutorialOwnerPageGeneration = -1;
                rendererGoneGeneration = -1;
                return;
            }
        }
        releaseTutorial(session, rendererGoneForSession);
    }

    private void releaseTutorial(TutorialSession session, boolean rendererGone) {
        synchronized (lock) {
            if (session.released) return;
            session.released = true;
            if (tutorialSession == session) tutorialSession = null;
            if (session.generation == tutorialGeneration) {
                tutorialGeneration++;
                hostState = HostState.CLOSED;
                openUrl = null;
                tutorialOwnerPageGeneration = -1;
                rendererGoneGeneration = -1;
            }
        }
        WebView webView = session.webView;
        try {
            if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
        } catch (RuntimeException ignored) { }
        if (!rendererGone) {
            try { webView.stopLoading(); } catch (RuntimeException ignored) { }
            try { webView.loadUrl("about:blank"); } catch (RuntimeException ignored) { }
        }
        try { webView.removeAllViews(); } catch (RuntimeException ignored) { }
        try {
            if (session.dialog.isShowing()) session.dialog.dismiss();
        } catch (RuntimeException ignored) { }
        try { webView.destroy(); } catch (RuntimeException ignored) { }
    }

    private static void detachAndDestroyUnregistered(WebView webView, Dialog dialog) {
        try {
            if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
        } catch (RuntimeException ignored) { }
        try { webView.stopLoading(); } catch (RuntimeException ignored) { }
        try { webView.loadUrl("about:blank"); } catch (RuntimeException ignored) { }
        try { webView.removeAllViews(); } catch (RuntimeException ignored) { }
        try { if (dialog.isShowing()) dialog.dismiss(); } catch (RuntimeException ignored) { }
        try { webView.destroy(); } catch (RuntimeException ignored) { }
    }

    private static void resolveOpened(PluginCall call) {
        JSObject result = new JSObject();
        result.put("status", "opened");
        call.resolve(result);
    }

    @Override
    public void handleOnDestroy() {
        synchronized (lock) { destroyed = true; mainPageGeneration++; mainPageReady = false; }
        closeTutorial();
        if (mainListener != null && getBridge() != null) getBridge().removeWebViewListener(mainListener);
        super.handleOnDestroy();
    }
}
