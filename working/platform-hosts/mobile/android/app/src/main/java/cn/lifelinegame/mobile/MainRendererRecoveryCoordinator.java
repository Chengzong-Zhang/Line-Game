package cn.lifelinegame.mobile;

import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.WebViewListener;

/** Bounded main-renderer recovery policy shared by Activity and JVM regression harness. */
final class MainRendererRecoveryCoordinator {
    interface Owner {
        boolean isActive();
        boolean owns(WebView webView);
    }

    interface Host {
        void destroyRenderer(WebView webView);
        void recreateAutomatically();
        void showManualRetry();
        void recreateManually();
    }

    private final Owner owner;
    private final Host host;
    private boolean automaticRecoveryConsumed;
    private boolean manualPromptShown;
    private boolean destroyed;
    private boolean failureHandled;
    private boolean rendererDestroyed;

    MainRendererRecoveryCoordinator(Owner owner, Host host, boolean automaticRecoveryConsumed) {
        this.owner = owner;
        this.host = host;
        this.automaticRecoveryConsumed = automaticRecoveryConsumed;
    }

    WebViewListener createListener() {
        return new WebViewListener() {
            @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                if (destroyed || !owner.isActive() || !owner.owns(webView)) return false;
                if (!rendererDestroyed) {
                    rendererDestroyed = true;
                    host.destroyRenderer(webView);
                }
                if (!failureHandled) {
                    failureHandled = true;
                    recover();
                }
                return true;
            }
        };
    }

    boolean onMainPageLoadFailure(WebView webView) {
        if (destroyed || !owner.isActive() || !owner.owns(webView)) return false;
        if (failureHandled) return true;
        failureHandled = true;
        recover();
        return true;
    }

    private void recover() {
        if (!automaticRecoveryConsumed) {
            automaticRecoveryConsumed = true;
            host.recreateAutomatically();
        } else if (!manualPromptShown) {
            manualPromptShown = true;
            host.showManualRetry();
        }
    }

    boolean retryManually() {
        if (destroyed || !owner.isActive() || !manualPromptShown) return false;
        manualPromptShown = false;
        host.recreateManually();
        return true;
    }

    void onActivityDestroyed() { destroyed = true; }

    boolean automaticRecoveryConsumed() { return automaticRecoveryConsumed; }
}
