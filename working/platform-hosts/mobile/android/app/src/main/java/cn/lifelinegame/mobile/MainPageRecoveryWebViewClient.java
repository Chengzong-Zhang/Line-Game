package cn.lifelinegame.mobile;

import android.graphics.Bitmap;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/** Adds main-document recovery while preserving Capacitor's normal WebView callbacks. */
final class MainPageRecoveryWebViewClient extends BridgeWebViewClient {
    private final WebView mainWebView;
    private final MainRendererRecoveryCoordinator recovery;
    private String currentMainFrameUrl;

    MainPageRecoveryWebViewClient(Bridge bridge, WebView mainWebView, MainRendererRecoveryCoordinator recovery) {
        super(bridge);
        this.mainWebView = mainWebView;
        this.recovery = recovery;
        this.currentMainFrameUrl = mainWebView.getUrl();
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
        if (view == mainWebView) currentMainFrameUrl = url;
        super.onPageStarted(view, url, favicon);
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        boolean recoverMainPage = isCurrentMainFrame(view, request);
        super.onReceivedError(view, request, error);
        if (recoverMainPage) recovery.onMainPageLoadFailure(view);
    }

    @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        boolean recoverMainPage = false;
        if (isCurrentMainFrame(view, request) && response != null) {
            int statusCode = response.getStatusCode();
            recoverMainPage = statusCode >= 400 && statusCode <= 599;
        }
        super.onReceivedHttpError(view, request, response);
        if (recoverMainPage) recovery.onMainPageLoadFailure(view);
    }

    private boolean isCurrentMainFrame(WebView view, WebResourceRequest request) {
        if (view != mainWebView || request == null || !request.isForMainFrame() || request.getUrl() == null) return false;
        return request.getUrl().toString().equals(currentMainFrameUrl);
    }
}
