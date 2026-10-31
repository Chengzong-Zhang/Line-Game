package cn.lifelinegame.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashSet;
import java.util.Set;

@CapacitorPlugin(name = "LifelineNetwork")
public final class LifelineNetworkPlugin extends Plugin {
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback callback;
    private Network currentDefault;
    private boolean available;
    private String validation = "unknown";
    private long revision = 0;
    private long generation = 0;
    private String subscriptionId = "";
    private boolean paused = false;
    private boolean pageReady = false;
    private boolean registrationBlocked = false;
    private final Set<String> cancelledSubscriptions = new LinkedHashSet<>();
    private WebViewListener webViewListener;

    @Override
    public void load() {
        super.load();
        webViewListener = new WebViewListener() {
            @Override public void onPageStarted(WebView webView) { pageReady = false; retireCurrentSubscription(); stopMonitoring(null); }
            @Override public void onPageLoaded(WebView webView) { pageReady = true; }
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                pageReady = false;
                retireCurrentSubscription();
                stopMonitoring(null);
                return false;
            }
        };
        getBridge().addWebViewListener(webViewListener);
    }

    private JSObject snapshot() {
        JSObject result = new JSObject();
        result.put("schemaVersion", 1);
        result.put("source", "android-native");
        result.put("revision", revision);
        result.put("availability", available ? "available" : "unavailable");
        result.put("validation", validation);
        return result;
    }

    private void publish() {
        revision += 1;
        JSObject event = new JSObject();
        event.put("status", snapshot());
        event.put("subscriptionId", subscriptionId);
        notifyListeners("networkStatusChange", event);
    }

    private void setCurrent(Network network) {
        currentDefault = network;
        available = network != null;
        validation = "unknown";
        publish();
    }

    @Override
    public void handleOnDestroy() {
        retireCurrentSubscription();
        stopMonitoring(null);
        if (webViewListener != null && getBridge() != null) {
            getBridge().removeWebViewListener(webViewListener);
            webViewListener = null;
        }
        super.handleOnDestroy();
    }

    @Override
    public void handleOnPause() {
        paused = true;
        retireCurrentSubscription();
        stopMonitoring(null);
        super.handleOnPause();
    }

    @Override
    public void handleOnResume() {
        paused = false;
        super.handleOnResume();
    }

    @PluginMethod
    public synchronized void getNetworkStatus(PluginCall call) {
        if (paused || !pageReady) {
            call.resolve(unknownSnapshot("background"));
            return;
        }
        try {
            if (connectivity == null) connectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivity == null) {
                call.resolve(unknownSnapshot("unavailable"));
                return;
            }
            Network active = connectivity.getActiveNetwork();
            currentDefault = active;
            available = active != null;
            validation = "unknown";
            if (active != null) {
                NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(active);
                if (capabilities != null) validation = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    ? "validated" : "unvalidated";
            }
            revision += 1;
            call.resolve(snapshot());
        } catch (Exception error) {
            call.reject("Network status is unavailable.");
        }
    }

    @PluginMethod
    public synchronized void startNetworkStatus(PluginCall call) {
        String requestedId = call.getString("subscriptionId", "");
        if (requestedId.isEmpty() || requestedId.length() > 96) {
            call.reject("Network subscription is invalid.");
            return;
        }
        if (paused || !pageReady) {
            call.reject("Network monitoring is unavailable in the background.");
            return;
        }
        if (cancelledSubscriptions.contains(requestedId)) {
            call.reject("Network subscription was cancelled.");
            return;
        }
        if (registrationBlocked) {
            call.reject("Prior network monitor cleanup is incomplete.");
            return;
        }
        if (callback != null && requestedId.equals(subscriptionId)) {
            call.resolve(snapshot());
            return;
        }
        if (callback != null) {
            retireCurrentSubscription();
            if (!stopMonitoring(subscriptionId)) {
                call.reject("Prior network monitor cleanup is incomplete.");
                return;
            }
        }
        try {
            if (connectivity == null) connectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivity == null) throw new IllegalStateException("Connectivity service unavailable.");
            final long ownGeneration = ++generation;
            subscriptionId = requestedId;
            callback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) {
                    synchronized (LifelineNetworkPlugin.this) {
                        if (ownGeneration != generation || callback == null) return;
                        setCurrent(network);
                    }
                }

                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    synchronized (LifelineNetworkPlugin.this) {
                        if (ownGeneration != generation || callback == null || currentDefault == null || !currentDefault.equals(network)) return;
                        String next = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                            ? "validated" : "unvalidated";
                        if (!next.equals(validation) || !available) {
                            available = true;
                            validation = next;
                            publish();
                        }
                    }
                }

                @Override public void onLost(Network network) {
                    synchronized (LifelineNetworkPlugin.this) {
                        if (ownGeneration != generation || callback == null || currentDefault == null || !currentDefault.equals(network)) return;
                        currentDefault = null;
                        available = false;
                        validation = "unknown";
                        publish();
                    }
                }

                @Override public void onUnavailable() {
                    synchronized (LifelineNetworkPlugin.this) {
                        if (ownGeneration != generation || callback == null) return;
                        currentDefault = null;
                        available = false;
                        validation = "unknown";
                        publish();
                    }
                }
            };
            connectivity.registerDefaultNetworkCallback(callback);
            // The snapshot is taken after registration. Its revision lets JS discard it if a newer callback arrived first.
            Network active = connectivity.getActiveNetwork();
            currentDefault = active;
            available = active != null;
            validation = "unknown";
            if (active != null) {
                NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(active);
                if (capabilities != null) validation = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    ? "validated" : "unvalidated";
            }
            revision += 1;
            call.resolve(snapshot());
        } catch (Exception error) {
            generation += 1;
            if (connectivity != null && callback != null) {
                try {
                    connectivity.unregisterNetworkCallback(callback);
                    callback = null;
                    subscriptionId = "";
                } catch (Exception ignored) { registrationBlocked = true; }
            }
            currentDefault = null;
            available = false;
            validation = "unknown";
            call.reject("Network monitoring registration failed.");
        }
    }

    @PluginMethod
    public synchronized void stopNetworkStatus(PluginCall call) {
        String requestedId = call.getString("subscriptionId", "");
        if (!requestedId.isEmpty()) {
            cancelledSubscriptions.add(requestedId);
            while (cancelledSubscriptions.size() > 64) cancelledSubscriptions.remove(cancelledSubscriptions.iterator().next());
        }
        if (!stopMonitoring(requestedId.isEmpty() ? null : requestedId)) {
            call.reject("Network monitor cleanup failed.");
            return;
        }
        call.resolve();
    }

    private synchronized boolean stopMonitoring(String requestedId) {
        if (requestedId != null && !requestedId.equals(subscriptionId)) return true;
        if (requestedId == null) retireCurrentSubscription();
        generation += 1;
        ConnectivityManager.NetworkCallback prior = callback;
        if (connectivity != null && prior != null) {
            try { connectivity.unregisterNetworkCallback(prior); }
            catch (Exception ignored) { registrationBlocked = true; return false; }
        }
        callback = null;
        subscriptionId = "";
        currentDefault = null;
        available = false;
        validation = "unknown";
        registrationBlocked = false;
        return true;
    }

    private void retireCurrentSubscription() {
        if (subscriptionId.isEmpty()) return;
        cancelledSubscriptions.add(subscriptionId);
        while (cancelledSubscriptions.size() > 64) cancelledSubscriptions.remove(cancelledSubscriptions.iterator().next());
    }

    private JSObject unknownSnapshot(String reason) {
        JSObject result = new JSObject();
        result.put("schemaVersion", 1);
        result.put("source", "android-native");
        result.put("revision", revision);
        result.put("availability", "unknown");
        result.put("validation", "unknown");
        result.put("reason", reason);
        return result;
    }
}
