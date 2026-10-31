"""Compile and exercise Android main-page recovery with host-side API stubs.

Pass --java-bin with the JDK bin directory. This verifies the app's callback
filter and recovery coordinator without building the Android APK or using a device.
"""
from pathlib import Path
import argparse
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
main_activity = (root / 'android/app/src/main/java/cn/lifelinegame/mobile/MainActivity.java').read_text(encoding='utf-8')
assert 'owner.setWebViewClient(new MainPageRecoveryWebViewClient(owner, owner.getWebView(), rendererRecovery))' in main_activity
assert '游戏页面发生错误，正在尝试恢复已保存的棋局。' in main_activity
assert '游戏页面加载失败或渲染进程停止。' in main_activity

stubs = {
    'android/graphics/Bitmap.java': r'''package android.graphics; public class Bitmap {}''',
    'android/net/Uri.java': r'''package android.net;
public final class Uri { private final String value; private Uri(String value) { this.value=value; }
  public static Uri parse(String value) { return new Uri(value); }
  @Override public String toString() { return value; }
}''',
    'android/webkit/WebView.java': r'''package android.webkit;
public class WebView { private String url; public int loads; public WebView(String url) { this.url=url; }
  public String getUrl() { return url; } public void loadUrl(String value) { url=value; loads++; }
  public int getProgress() { return 100; }
}''',
    'android/webkit/WebResourceRequest.java': r'''package android.webkit;
import android.net.Uri;
public class WebResourceRequest { private final boolean main; private final Uri url;
  public WebResourceRequest(boolean main, String url) { this.main=main; this.url=Uri.parse(url); }
  public boolean isForMainFrame() { return main; } public Uri getUrl() { return url; }
}''',
    'android/webkit/WebResourceError.java': r'''package android.webkit; public class WebResourceError {}''',
    'android/webkit/WebResourceResponse.java': r'''package android.webkit;
public class WebResourceResponse { private final int code; public WebResourceResponse(int code) { this.code=code; }
  public int getStatusCode() { return code; }
}''',
    'android/webkit/RenderProcessGoneDetail.java': r'''package android.webkit; public class RenderProcessGoneDetail {}''',
    'com/getcapacitor/Bridge.java': r'''package com.getcapacitor;
import android.webkit.WebView; import java.util.ArrayList; import java.util.List;
public class Bridge { public final List<WebViewListener> listeners=new ArrayList<>(); public String errorUrl;
  public void addWebViewListener(WebViewListener listener) { listeners.add(listener); }
  public List<WebViewListener> getWebViewListeners() { return listeners; }
  public String getErrorUrl() { return errorUrl; } public void reset() {}
}''',
    'com/getcapacitor/WebViewListener.java': r'''package com.getcapacitor;
import android.graphics.Bitmap; import android.webkit.*;
public class WebViewListener {
  public void onPageStarted(WebView view) {} public void onPageLoaded(WebView view) {}
  public void onReceivedError(WebView view) {} public void onReceivedHttpError(WebView view) {}
  public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { return false; }
  public void onPageCommitVisible(WebView view, String url) {}
}''',
    'com/getcapacitor/BridgeWebViewClient.java': r'''package com.getcapacitor;
import android.graphics.Bitmap; import android.webkit.*;
public class BridgeWebViewClient {
  protected final Bridge bridge; public BridgeWebViewClient(Bridge bridge) { this.bridge=bridge; }
  public void onPageStarted(WebView view, String url, Bitmap favicon) {
    bridge.reset(); for (WebViewListener listener: bridge.getWebViewListeners()) listener.onPageStarted(view);
  }
  public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
    for (WebViewListener listener: bridge.getWebViewListeners()) listener.onReceivedError(view);
    if (bridge.getErrorUrl()!=null && request.isForMainFrame()) view.loadUrl(bridge.getErrorUrl());
  }
  public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
    for (WebViewListener listener: bridge.getWebViewListeners()) listener.onReceivedHttpError(view);
    if (bridge.getErrorUrl()!=null && request.isForMainFrame()) view.loadUrl(bridge.getErrorUrl());
  }
}''',
    'MainPageRecoveryProbe.java': r'''package cn.lifelinegame.mobile;
import android.webkit.*;
import com.getcapacitor.*;

public final class MainPageRecoveryProbe {
  private static int checks;
  private static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
  private static final String A="https://localhost/index.html", B="https://localhost/retry.html";
  private static final class Harness implements MainRendererRecoveryCoordinator.Owner, MainRendererRecoveryCoordinator.Host {
    final WebView view; boolean active=true; int destroyed, automatic, prompts, manual;
    Harness(String url) { view=new WebView(url); }
    public boolean isActive() { return active; } public boolean owns(WebView candidate) { return candidate==view; }
    public void destroyRenderer(WebView ignored) { destroyed++; }
    public void recreateAutomatically() { automatic++; }
    public void showManualRetry() { prompts++; }
    public void recreateManually() { manual++; }
    MainRendererRecoveryCoordinator coordinator(boolean consumed) { return new MainRendererRecoveryCoordinator(this,this,consumed); }
    MainPageRecoveryWebViewClient client(Bridge bridge, MainRendererRecoveryCoordinator recovery) {
      bridge.addWebViewListener(recovery.createListener()); return new MainPageRecoveryWebViewClient(bridge,view,recovery);
    }
  }
  public static void main(String[] args) {
    Harness h=new Harness(A); Bridge bridge=new Bridge();
    MainRendererRecoveryCoordinator c=h.coordinator(false); MainPageRecoveryWebViewClient client=h.client(bridge,c);
    client.onPageStarted(h.view,A,null);
    client.onReceivedError(h.view,new WebResourceRequest(false,A+"/image.png"),new WebResourceError());
    client.onReceivedHttpError(h.view,new WebResourceRequest(false,A+"/app.js"),new WebResourceResponse(500));
    check(h.automatic==0 && h.prompts==0,"subresource failures must not start recovery");
    check(h.view.loads==0,"subresource errors must not enter Capacitor's main-page error route");
    client.onReceivedHttpError(h.view,new WebResourceRequest(true,A),new WebResourceResponse(399));
    check(h.automatic==0,"main-frame status below 400 must not recover");
    client.onReceivedHttpError(h.view,new WebResourceRequest(true,A),new WebResourceResponse(600));
    check(h.automatic==0,"main-frame status above 599 must not recover");
    client.onReceivedError(h.view,new WebResourceRequest(true,A),new WebResourceError());
    check(h.automatic==1 && c.automaticRecoveryConsumed(),"main-frame load error consumes one automatic recovery");
    check(h.destroyed==0,"a live renderer is not destroyed for a load error");
    client.onReceivedError(h.view,new WebResourceRequest(true,A),new WebResourceError());
    client.onReceivedHttpError(h.view,new WebResourceRequest(true,A),new WebResourceResponse(599));
    check(h.automatic==1 && h.prompts==0,"duplicate callbacks cannot schedule another automatic recovery");
    check(bridge.listeners.get(0).onRenderProcessGone(h.view,new RenderProcessGoneDetail()),"renderer loss after a page error remains handled");
    check(h.destroyed==1 && h.automatic==1,"renderer is destroyed once without duplicating page recovery");
    c.onActivityDestroyed(); h.active=false;
    check(!c.onMainPageLoadFailure(h.view),"callbacks from a destroyed Activity generation are rejected");

    Harness second=new Harness(B); Bridge secondBridge=new Bridge();
    MainRendererRecoveryCoordinator secondC=second.coordinator(true);
    MainPageRecoveryWebViewClient secondClient=second.client(secondBridge,secondC);
    secondClient.onPageStarted(second.view,B,null);
    client.onReceivedError(h.view,new WebResourceRequest(true,A),new WebResourceError());
    check(second.prompts==0,"an old page callback cannot affect the replacement page generation");
    secondClient.onReceivedHttpError(second.view,new WebResourceRequest(true,B),new WebResourceResponse(400));
    check(second.prompts==1 && second.automatic==0,"HTTP 400 after automatic recovery shows manual retry");
    secondClient.onReceivedHttpError(second.view,new WebResourceRequest(true,B),new WebResourceResponse(599));
    check(second.prompts==1,"duplicate HTTP failures show only one prompt");
    check(secondC.retryManually() && second.manual==1,"manual retry recreates the failed page");
    secondC.onActivityDestroyed();

    Harness third=new Harness(A); Bridge thirdBridge=new Bridge();
    MainRendererRecoveryCoordinator thirdC=third.coordinator(true);
    MainPageRecoveryWebViewClient thirdClient=third.client(thirdBridge,thirdC);
    thirdClient.onPageStarted(third.view,A,null);
    thirdClient.onReceivedHttpError(third.view,new WebResourceRequest(true,A),new WebResourceResponse(599));
    check(third.prompts==1,"a later failed manual retry exposes another manual retry entry");

    Harness upperBound=new Harness(A); Bridge upperBridge=new Bridge();
    MainRendererRecoveryCoordinator upperC=upperBound.coordinator(false);
    MainPageRecoveryWebViewClient upperClient=upperBound.client(upperBridge,upperC);
    upperClient.onPageStarted(upperBound.view,A,null);
    upperClient.onReceivedHttpError(upperBound.view,new WebResourceRequest(true,A),new WebResourceResponse(599));
    check(upperBound.automatic==1,"main-frame HTTP 599 is inside the recovery range");

    Harness stale=new Harness(A); Bridge staleBridge=new Bridge();
    MainRendererRecoveryCoordinator staleC=stale.coordinator(false);
    MainPageRecoveryWebViewClient staleClient=stale.client(staleBridge,staleC);
    staleClient.onPageStarted(stale.view,A,null); staleClient.onPageStarted(stale.view,B,null);
    staleClient.onReceivedHttpError(stale.view,new WebResourceRequest(true,A),new WebResourceResponse(500));
    check(stale.automatic==0,"late error from an older URL in the same WebView is ignored");
    staleClient.onReceivedHttpError(stale.view,new WebResourceRequest(true,B),new WebResourceResponse(500));
    check(stale.automatic==1,"current main-frame HTTP 500 triggers recovery");

    Harness foreign=new Harness(A); Bridge foreignBridge=new Bridge();
    MainRendererRecoveryCoordinator foreignC=foreign.coordinator(false);
    MainPageRecoveryWebViewClient foreignClient=foreign.client(foreignBridge,foreignC);
    foreignClient.onPageStarted(foreign.view,A,null);
    foreignClient.onReceivedError(new WebView(A),new WebResourceRequest(true,A),new WebResourceError());
    check(foreign.automatic==0,"callbacks from a WebView outside this Bridge are ignored");
    System.out.println("verify-android-main-page-recovery: PASS ("+checks+" assertions)");
  }
}''',
}

sources = [
    root / 'android/app/src/main/java/cn/lifelinegame/mobile/MainRendererRecoveryCoordinator.java',
    root / 'android/app/src/main/java/cn/lifelinegame/mobile/MainPageRecoveryWebViewClient.java',
]

with tempfile.TemporaryDirectory(prefix='lifeline-android-main-recovery-') as tmp:
    temp = Path(tmp)
    java_sources = []
    for relative, content in stubs.items():
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        java_sources.append(str(target))
    java_sources.extend(map(str, sources))
    classes = temp / 'classes'
    classes.mkdir()
    suffix = '.exe' if sys.platform == 'win32' else ''
    javac = args.java_bin / ('javac' + suffix)
    java = args.java_bin / ('java' + suffix)
    compiled = subprocess.run([str(javac), '-encoding', 'UTF-8', '-d', str(classes), *java_sources], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    if compiled.returncode:
        raise SystemExit(compiled.stdout + compiled.stderr)
    result = subprocess.run([str(java), '-cp', str(classes), 'cn.lifelinegame.mobile.MainPageRecoveryProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    print(result.stdout.strip())
