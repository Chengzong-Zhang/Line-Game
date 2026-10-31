package cn.lifelinegame.mobile;

import android.app.AlertDialog;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final String STATE_RENDERER_RECOVERY_CONSUMED = "lifeline.rendererRecoveryConsumed";
    private MainRendererRecoveryCoordinator rendererRecovery;
    private WebViewListener rendererListener;
    private boolean activityDestroyed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LifelineStoragePlugin.class);
        registerPlugin(LifelineCapabilitiesPlugin.class);
        registerPlugin(LifelineNetworkPlugin.class);
        registerPlugin(LifelineHapticsPlugin.class);
        registerPlugin(LifelineReplayImportPlugin.class);
        registerPlugin(LifelineTutorialHostPlugin.class);
        super.onCreate(savedInstanceState);
        boolean recoveryConsumed = savedInstanceState != null
            && savedInstanceState.getBoolean(STATE_RENDERER_RECOVERY_CONSUMED, false);
        registerRendererRecoveryListener(recoveryConsumed);
    }

    private void registerRendererRecoveryListener(boolean recoveryConsumed) {
        final Bridge owner = getBridge();
        if (owner == null) return;
        rendererRecovery = new MainRendererRecoveryCoordinator(new MainRendererRecoveryCoordinator.Owner() {
            @Override public boolean isActive() {
                return !activityDestroyed && owner == getBridge() && !isFinishing() && !isDestroyed();
            }
            @Override public boolean owns(WebView webView) {
                return owner.getWebView() == webView;
            }
        }, new MainRendererRecoveryCoordinator.Host() {
            @Override public void destroyRenderer(WebView webView) {
                if (webView.getParent() instanceof ViewGroup) {
                    ((ViewGroup) webView.getParent()).removeView(webView);
                }
                webView.destroy();
            }
            @Override public void recreateAutomatically() {
                runOnUiThread(() -> {
                    if (!activityDestroyed && owner == getBridge() && !isFinishing()) {
                        Toast.makeText(MainActivity.this, "游戏页面发生错误，正在尝试恢复已保存的棋局。", Toast.LENGTH_LONG).show();
                        recreate();
                    }
                });
            }
            @Override public void showManualRetry() {
                runOnUiThread(() -> showRendererRecoveryPrompt(owner));
            }
            @Override public void recreateManually() {
                if (!activityDestroyed && owner == getBridge() && !isFinishing()) recreate();
            }
        }, recoveryConsumed);
        rendererListener = rendererRecovery.createListener();
        owner.addWebViewListener(rendererListener);
        owner.setWebViewClient(new MainPageRecoveryWebViewClient(owner, owner.getWebView(), rendererRecovery));
    }

    private void showRendererRecoveryPrompt(Bridge owner) {
        if (activityDestroyed || owner != getBridge() || isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
            .setTitle("游戏页面暂时无法恢复")
            .setMessage("游戏页面加载失败或渲染进程停止。已保存的棋局会在重试后重新载入。你可以再次手动重试，或关闭应用。")
            .setCancelable(false)
            .setPositiveButton("重新打开页面", (dialog, which) -> rendererRecovery.retryManually())
            .setNegativeButton("关闭应用", (dialog, which) -> finishAndRemoveTask())
            .show();
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        if (rendererRecovery != null) {
            outState.putBoolean(STATE_RENDERER_RECOVERY_CONSUMED, rendererRecovery.automaticRecoveryConsumed());
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onDestroy() {
        activityDestroyed = true;
        if (rendererRecovery != null) rendererRecovery.onActivityDestroyed();
        Bridge owner = getBridge();
        if (owner != null && rendererListener != null) owner.removeWebViewListener(rendererListener);
        rendererListener = null;
        super.onDestroy();
    }
}
