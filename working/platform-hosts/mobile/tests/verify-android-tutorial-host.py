"""Compile and exercise the real Android tutorial host plugin with API stubs.

This is a desktop-JDK contract check, not an Android SDK build or device test.
"""
from pathlib import Path
import argparse
import hashlib
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, help='JDK bin directory (defaults to PATH)')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
plugin = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java'
source = plugin.read_bytes()
source_hash = hashlib.sha256(source).hexdigest().upper()
suffix = '.exe' if sys.platform == 'win32' else ''
java_bin = args.java_bin.resolve() if args.java_bin else None
javac = java_bin / ('javac' + suffix) if java_bin else Path('javac' + suffix)
java = java_bin / ('java' + suffix) if java_bin else Path('java' + suffix)

stubs = {
    'android/net/Uri.java': r'''package android.net;
import java.net.*;import java.nio.charset.StandardCharsets;import java.util.*;
public final class Uri { private final URI u; private Uri(String s){try{u=new URI(s);}catch(Exception e){throw new IllegalArgumentException(e);}}
 public static Uri parse(String s){return new Uri(s);} public boolean isHierarchical(){return !u.isOpaque();} public String getScheme(){return u.getScheme();} public String getHost(){return u.getHost();} public int getPort(){return u.getPort();} public String getUserInfo(){return u.getRawUserInfo()==null?null:decode(u.getRawUserInfo());} public String getPath(){return u.getPath();} public String getFragment(){return u.getRawFragment();}
 private static String decode(String s){return URLDecoder.decode(s,StandardCharsets.UTF_8);} private List<String[]> query(){List<String[]> out=new ArrayList<>();String q=u.getRawQuery();if(q==null)return out;for(String p:q.split("&",-1)){int i=p.indexOf('=');out.add(new String[]{decode(i<0?p:p.substring(0,i)),decode(i<0?"":p.substring(i+1))});}return out;}
 public Set<String> getQueryParameterNames(){Set<String> out=new LinkedHashSet<>();for(String[] p:query())out.add(p[0]);return out;} public List<String> getQueryParameters(String key){List<String> out=new ArrayList<>();for(String[] p:query())if(p[0].equals(key))out.add(p[1]);return out;} public String getQueryParameter(String key){List<String> v=getQueryParameters(key);return v.isEmpty()?null:v.get(0);} public String toString(){return u.toString();}
}''',
    'android/app/Activity.java': r'''package android.app;
import android.content.res.AssetManager;import android.view.*;import android.webkit.WebView;import java.util.*;
public class Activity {public boolean finishing,destroyed,throwOnPost;public final List<Runnable> queue=new ArrayList<>();public final List<WebView> webViews=new ArrayList<>();public final List<Dialog> dialogs=new ArrayList<>();private final AssetManager assets=new AssetManager();
 public void runOnUiThread(Runnable r){if(throwOnPost)throw new RuntimeException("post failed");queue.add(r);}public boolean isFinishing(){return finishing;}public boolean isDestroyed(){return destroyed;}public AssetManager getAssets(){return assets;}
 public void drain(){int guard=0;while(!queue.isEmpty()){if(++guard>1000)throw new IllegalStateException("queue runaway");queue.remove(0).run();}}}''',
    'android/content/res/AssetManager.java': r'''package android.content.res;import java.io.*;import java.nio.charset.StandardCharsets;import java.util.*;
public class AssetManager {public final Map<String,byte[]> files=new HashMap<>();public AssetManager(){files.put("public/index.html","<html><head><title>tutorial</title></head><body>local</body></html>".getBytes(StandardCharsets.UTF_8));files.put("public/app.js","window.local=true;".getBytes(StandardCharsets.UTF_8));}
 public InputStream open(String name)throws IOException{byte[] b=files.get(name);if(b==null)throw new FileNotFoundException(name);return new ByteArrayInputStream(b);}}''',
    'android/graphics/Color.java': '''package android.graphics; public final class Color {public static final int WHITE=-1;public static int rgb(int r,int g,int b){return (r<<16)|(g<<8)|b;}}''',
    'android/view/Gravity.java': '''package android.view; public final class Gravity {public static final int CENTER=17;}''',
    'android/view/View.java': r'''package android.view;import android.app.Activity;public class View {public static final int GONE=8,VISIBLE=0;private Object parent;private OnClickListener listener;public int visibility=VISIBLE;public View(Activity a){}public Object getParent(){return parent;}public void setParent(Object p){parent=p;}public void setVisibility(int v){visibility=v;}public int getVisibility(){return visibility;}public void setOnClickListener(OnClickListener l){listener=l;}public void performClick(){if(listener!=null)listener.onClick(this);}public interface OnClickListener{void onClick(View view);}}''',
    'android/view/ViewGroup.java': r'''package android.view;import android.app.Activity;import java.util.*;public class ViewGroup extends View {public static final class LayoutParams {public static final int MATCH_PARENT=-1,WRAP_CONTENT=-2;public int width,height;public float weight;public LayoutParams(int w,int h){width=w;height=h;}public LayoutParams(int w,int h,float x){width=w;height=h;weight=x;}}private final List<View> children=new ArrayList<>();public ViewGroup(Activity a){super(a);}public void addView(View v,LayoutParams p){children.add(v);v.setParent(this);}public void removeView(View v){children.remove(v);v.setParent(null);}public List<View> children(){return children;}public void setBackgroundColor(int c){}}''',
    'android/widget/LinearLayout.java': r'''package android.widget;import android.app.Activity;import android.view.*;public class LinearLayout extends ViewGroup {public static final int VERTICAL=1;public LinearLayout(Activity a){super(a);}public void setOrientation(int v){}}''',
    'android/widget/Button.java': r'''package android.widget;import android.app.Activity;import android.view.View;public class Button extends View {public String text;public Button(Activity a){super(a);}public void setText(String s){text=s;}}''',
    'android/widget/TextView.java': r'''package android.widget;import android.app.Activity;import android.view.View;public class TextView extends View {public String text;public TextView(Activity a){super(a);}public void setText(String s){text=s;}public void setTextColor(int c){}}''',
    'android/app/Dialog.java': r'''package android.app;import android.view.*;import java.util.function.Consumer;public class Dialog {private final Activity a;private View content;private boolean showing;private Consumer<Dialog> dismiss;private final Window window=new Window();public Dialog(Activity a){this.a=a;a.dialogs.add(this);}public void setContentView(View v){content=v;}public View getContentView(){return content;}public void setOnDismissListener(Consumer<Dialog> c){dismiss=c;}public void show(){showing=true;}public boolean isShowing(){return showing;}public void dismiss(){if(!showing)return;showing=false;if(dismiss!=null)dismiss.accept(this);}public Window getWindow(){return window;}public static class Window {public int width,height,gravity;public void setLayout(int w,int h){width=w;height=h;}public void setGravity(int g){gravity=g;}}}''',
    'android/os/Looper.java': '''package android.os;public final class Looper {private static final Looper MAIN=new Looper();public static Looper getMainLooper(){return MAIN;}}''',
    'android/os/Handler.java': '''package android.os;public class Handler {public Handler(Looper l){}public boolean post(Runnable r){return false;}}''',
    'android/webkit/WebSettings.java': r'''package android.webkit;public class WebSettings {public boolean js,dom,file,content,block;public void setJavaScriptEnabled(boolean v){js=v;}public void setDomStorageEnabled(boolean v){dom=v;}public void setAllowFileAccess(boolean v){file=v;}public void setAllowContentAccess(boolean v){content=v;}public void setBlockNetworkLoads(boolean v){block=v;}}''',
    'android/webkit/RenderProcessGoneDetail.java': '''package android.webkit;public class RenderProcessGoneDetail {}''',
    'android/webkit/WebResourceRequest.java': r'''package android.webkit;import android.net.Uri;public class WebResourceRequest {private final Uri uri;private final boolean main;public WebResourceRequest(String s,boolean m){uri=Uri.parse(s);main=m;}public Uri getUrl(){return uri;}public boolean isForMainFrame(){return main;}}''',
    'android/webkit/WebResourceError.java': '''package android.webkit;public class WebResourceError {}''',
    'android/webkit/WebResourceResponse.java': r'''package android.webkit;import java.io.*;import java.util.*;public class WebResourceResponse {public final String mime,encoding,reason;public final int status;public final Map<String,String> headers;public final InputStream data;public WebResourceResponse(String m,String e,InputStream d){mime=m;encoding=e;data=d;status=200;reason="OK";headers=Map.of();}public WebResourceResponse(String m,String e,int s,String r,Map<String,String> h,InputStream d){mime=m;encoding=e;status=s;reason=r;headers=h;data=d;}public InputStream getData(){return data;}}''',
    'android/webkit/WebViewClient.java': r'''package android.webkit;public class WebViewClient {public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){return null;}public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return false;}public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){return false;}public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){}}''',
    'android/webkit/WebView.java': r'''package android.webkit;import android.app.Activity;import android.view.*;import java.util.*;public class WebView extends View {private final WebSettings settings=new WebSettings();private WebViewClient client;public final List<String> loaded=new ArrayList<>();public int stopped,removed,destroyed;public WebView(Activity a){super(a);if(a!=null)a.webViews.add(this);}public WebSettings getSettings(){return settings;}public void setWebViewClient(WebViewClient c){client=c;}public WebViewClient client(){return client;}public void loadUrl(String u){loaded.add(u);}public void stopLoading(){stopped++;}public void removeAllViews(){removed++;}public void destroy(){destroyed++;}public WebResourceResponse request(String u){return client.shouldInterceptRequest(this,new WebResourceRequest(u,false));}public boolean navigate(String u){return client.shouldOverrideUrlLoading(this,new WebResourceRequest(u,true));}public boolean rendererGone(){return client.onRenderProcessGone(this,new RenderProcessGoneDetail());}public void mainError(){client.onReceivedError(this,new WebResourceRequest("https://localhost/index.html?tutorial=1",true),new WebResourceError());}}''',
    'androidx/webkit/WebViewAssetLoader.java': r'''package androidx.webkit;import android.net.Uri;import android.webkit.*;public class WebViewAssetLoader {public interface PathHandler {WebResourceResponse handle(String path);}public static PathHandler lastHandler;public static String domain;private final PathHandler handler;private WebViewAssetLoader(PathHandler h){handler=h;}public WebResourceResponse shouldInterceptRequest(Uri u){String p=u.getPath();return handler.handle(p.startsWith("/")?p.substring(1):p);}public static class Builder {private PathHandler h;public Builder setDomain(String d){domain=d;return this;}public Builder addPathHandler(String p,PathHandler h){this.h=h;lastHandler=h;return this;}public WebViewAssetLoader build(){return new WebViewAssetLoader(h);}}}''',
    'com/getcapacitor/JSObject.java': r'''package com.getcapacitor;import java.util.*;public class JSObject {private final Map<String,Object> v=new LinkedHashMap<>();public JSObject put(String k,Object x){v.put(k,x);return this;}public Object get(String k){return v.get(k);}}''',
    'com/getcapacitor/PluginCall.java': r'''package com.getcapacitor;public class PluginCall {private final JSObject data=new JSObject();public JSObject result;public String error,code;public int resolves,rejects;public PluginCall put(String k,Object v){data.put(k,v);return this;}public String getString(String k,String d){Object v=data.get(k);return v instanceof String?(String)v:d;}public void resolve(JSObject r){result=r;resolves++;}public void reject(String m,String c){error=m;code=c;rejects++;}}''',
    'com/getcapacitor/PluginMethod.java': '''package com.getcapacitor;public @interface PluginMethod {}''',
    'com/getcapacitor/annotation/CapacitorPlugin.java': '''package com.getcapacitor.annotation;public @interface CapacitorPlugin {String name();}''',
    'com/getcapacitor/WebViewListener.java': r'''package com.getcapacitor;import android.webkit.*;public class WebViewListener {public void onPageStarted(WebView w){}public void onPageLoaded(WebView w){}public boolean onRenderProcessGone(WebView w,RenderProcessGoneDetail d){return false;}}''',
    'com/getcapacitor/Bridge.java': r'''package com.getcapacitor;import android.webkit.WebView;import java.util.*;public class Bridge {public WebView webView=new WebView(null);public final List<WebViewListener> listeners=new ArrayList<>();public void addWebViewListener(WebViewListener l){listeners.add(l);}public void removeWebViewListener(WebViewListener l){listeners.remove(l);}public WebView getWebView(){return webView;}}''',
    'com/getcapacitor/Plugin.java': r'''package com.getcapacitor;import android.app.Activity;public class Plugin {public static Activity activity;private final Bridge bridge=new Bridge();public Bridge getBridge(){return bridge;}public Activity getActivity(){return activity;}public void load(){}public void handleOnDestroy(){}}''',
    'TutorialHostProbe.java': r'''import android.app.*;import android.content.res.*;import android.net.Uri;import android.view.*;import android.webkit.*;import android.widget.*;import androidx.webkit.WebViewAssetLoader;import com.getcapacitor.*;import cn.lifelinegame.mobile.LifelineTutorialHostPlugin;import java.nio.charset.StandardCharsets;
public final class TutorialHostProbe {
 static int assertions,failed;
 static void ok(boolean v,String m){assertions++;if(!v)throw new AssertionError(m);}
 static void test(String n,Runnable r){try{r.run();System.out.println("PASS\t"+n);}catch(Throwable e){failed++;System.out.println("FAIL\t"+n+"\t"+e.getClass().getSimpleName()+": "+e.getMessage());}}
 static final String A="https://localhost/index.html?tutorial=1",B="https://localhost/?tutorial=1";
 static final class F {final Activity a=new Activity();final LifelineTutorialHostPlugin p;final Bridge b;F(){Plugin.activity=a;p=new LifelineTutorialHostPlugin();b=p.getBridge();b.webView=new WebView(a);p.load();}void ready(){b.listeners.get(0).onPageLoaded(b.webView);}void start(){b.listeners.get(0).onPageStarted(b.webView);}PluginCall open(String u){PluginCall c=new PluginCall().put("url",u);p.openTutorial(c);return c;}WebView tutorial(){return a.webViews.get(a.webViews.size()-1);}Button closeButton(){return find(a.dialogs.get(a.dialogs.size()-1).getContentView());}Button find(View v){if(v instanceof Button)return(Button)v;if(v instanceof ViewGroup)for(View x:((ViewGroup)v).children()){Button b=find(x);if(b!=null)return b;}return null;}WebViewClient client(){return tutorial().client();}void opened(){ready();PluginCall c=open(A);a.drain();ok(c.error==null&&"opened".equals(c.result.get("status")),"open failed");}}
 static void rejected(F f,String url,String code){PluginCall c=f.open(url);ok(c.result==null&&c.rejects==1&&code.equals(c.code),"expected "+code+" for "+url+", got "+c.code);}
 static String body(WebResourceResponse r){try{return new String(r.data.readAllBytes(),StandardCharsets.UTF_8);}catch(Exception e){throw new RuntimeException(e);}}
 public static void main(String[] args)throws Exception{
  test("same-origin tutorial whitelist accepts canonical root/index and explicit port 443",()->{for(String u:new String[]{A,B,"https://localhost:443/index.html?tutorial=1"}){F f=new F();f.ready();PluginCall c=f.open(u);f.a.drain();ok(c.error==null&&c.result!=null&&"opened".equals(c.result.get("status")),"allowed URL rejected: "+u);}});
  test("URL whitelist rejects user info and alternate ports",()->{F f=new F();f.ready();rejected(f,"https://user@localhost/index.html?tutorial=1","invalid-tutorial-url");rejected(f,"https://localhost:444/index.html?tutorial=1","invalid-tutorial-url");});
  test("URL whitelist rejects paths and fragments",()->{F f=new F();f.ready();rejected(f,"https://localhost/other?tutorial=1","invalid-tutorial-url");rejected(f,"https://localhost/index.html/extra?tutorial=1","invalid-tutorial-url");rejected(f,"https://localhost/index.html?tutorial=1#x","invalid-tutorial-url");});
  test("URL whitelist rejects duplicate, missing, wrong, or extra query parameters",()->{F f=new F();f.ready();for(String u:new String[]{"https://localhost/index.html?tutorial=1&tutorial=1","https://localhost/index.html?tutorial=1&room=x","https://localhost/index.html?room=x","https://localhost/index.html?tutorial=0","https://localhost/index.html?tutorial=1&","https://localhost/index.html?tutorial=1&%74utorial=1"})rejected(f,u,"invalid-tutorial-url");});
  test("not-ready page rejects without UI work",()->{F f=new F();PluginCall c=f.open(A);ok("host-unavailable".equals(c.code)&&f.a.queue.isEmpty(),"unready page accepted");});
  test("page generation change before queued open rejects stale request",()->{F f=new F();f.ready();PluginCall c=f.open(A);f.start();f.a.drain();ok("stale-request".equals(c.code)&&f.a.dialogs.isEmpty(),"stale open constructed dialog");});
  test("unavailable, finishing, and destroyed Activity reject open",()->{for(int mode=0;mode<3;mode++){F f=new F();f.ready();if(mode==0)Plugin.activity=null;else if(mode==1)f.a.finishing=true;else f.a.destroyed=true;PluginCall c=f.open(A);ok("host-unavailable".equals(c.code),"Activity mode "+mode+" accepted");Plugin.activity=f.a;}});
  test("duplicate same URL resolves idempotently and another URL is rejected",()->{F f=new F();f.opened();PluginCall same=f.open(A);PluginCall other=f.open(B);ok("opened".equals(same.result.get("status")),"same URL not idempotent");ok("already-open".equals(other.code),"different URL replaced live tutorial");ok(f.a.dialogs.size()==1,"duplicate created dialog");});
  test("second open while first is queued reports busy",()->{F f=new F();f.ready();PluginCall first=f.open(A);PluginCall second=f.open(A);ok("host-busy".equals(second.code),"opening state not reserved");f.a.drain();ok(first.result!=null,"first open failed");});
  test("close button releases the view once and stale renderer callback cannot close a replacement",()->{F f=new F();f.opened();WebView old=f.tutorial();WebViewClient oldClient=old.client();f.closeButton().performClick();f.a.drain();ok(old.destroyed==1&&old.stopped==1&&old.loaded.contains("about:blank"),"close did not release webview");PluginCall c=f.open(A);f.a.drain();ok(c.result!=null,"reopen after close failed");WebView current=f.tutorial();ok(oldClient.onRenderProcessGone(old,new RenderProcessGoneDetail()),"renderer callback not consumed");f.a.drain();ok(current.destroyed==0,"stale renderer callback closed replacement");});
  test("main navigation and main renderer loss close tutorial and isolate old callbacks",()->{F f=new F();f.opened();WebView old=f.tutorial();WebViewClient oldClient=old.client();f.start();f.a.drain();ok(old.destroyed==1,"main navigation retained tutorial");f.ready();PluginCall c=f.open(A);f.a.drain();WebView current=f.tutorial();oldClient.onRenderProcessGone(old,new RenderProcessGoneDetail());f.a.drain();ok(current.destroyed==0,"old renderer callback affected new generation");F g=new F();g.opened();g.b.listeners.get(0).onRenderProcessGone(g.b.webView,new RenderProcessGoneDetail());g.a.drain();ok(g.tutorial().destroyed==1,"main renderer gone did not close tutorial");});
  test("destroy removes main listener and closes tutorial safely",()->{F f=new F();f.opened();WebView w=f.tutorial();f.p.handleOnDestroy();f.a.drain();ok(w.destroyed==1&&f.b.listeners.isEmpty(),"destroy did not clean resources");PluginCall c=f.open(A);ok("host-unavailable".equals(c.code),"destroyed plugin reopened");});
  test("tutorial WebView disables network, file access, and content access",()->{F f=new F();f.opened();WebSettings s=f.tutorial().getSettings();ok(s.block&&!s.file&&!s.content&&s.js&&s.dom,"WebView settings contract changed");});
  test("tutorial document is served from packaged assets with restrictive CSP",()->{F f=new F();f.opened();WebResourceResponse r=f.tutorial().request(A);String html=body(r);ok(r.status==200&&"text/html".equals(r.mime),"document not served locally");ok(html.contains("connect-src 'none'")&&html.indexOf("Content-Security-Policy")>html.toLowerCase().indexOf("<head"),"CSP missing from document");ok(!html.contains("about:"),"unexpected document");});
  test("non-local requests are blocked and trusted static requests use bundled asset loader",()->{F f=new F();f.opened();WebResourceResponse external=f.tutorial().request("https://evil.example/app.js");ok(external.status==404&&"no-store".equals(external.headers.get("Cache-Control")),"external request not blocked");WebResourceResponse asset=f.tutorial().request("https://localhost/app.js");ok(asset.status==200&&"application/javascript".equals(asset.mime)&&body(asset).contains("window.local"),"bundled asset missing");ok("localhost".equals(WebViewAssetLoader.domain),"asset loader domain changed");});
  test("asset path traversal and missing paths fail closed",()->{F f=new F();f.opened();for(String p:new String[]{"../secret","a/../secret","/absolute","a\\..\\secret","missing.js"}){WebResourceResponse r=WebViewAssetLoader.lastHandler.handle(p);ok(r.status==404,"path accepted: "+p);}});
  test("external navigation is blocked while canonical tutorial navigation is allowed",()->{F f=new F();f.opened();ok(f.tutorial().navigate("https://evil.example/") ,"external navigation allowed");ok(!f.tutorial().navigate(A),"canonical tutorial navigation blocked");ok(f.tutorial().navigate("https://localhost/index.html?tutorial=1&extra=1"),"extra parameter navigation allowed");});
  test("renderer-gone cleanup skips unsafe stop and blank navigation",()->{F f=new F();f.opened();WebView w=f.tutorial();ok(w.rendererGone(),"renderer loss not handled");f.a.drain();ok(w.destroyed==1&&w.stopped==0&&!w.loaded.contains("about:blank"),"renderer-gone cleanup touched dead renderer");});
  test("main-frame tutorial load error reveals recovery message",()->{F f=new F();f.opened();TextView message=findText(f.a.dialogs.get(0).getContentView());ok(message!=null&&message.text.contains("Tutorial page failed"),"load recovery hint missing");ok(message.getVisibility()==View.GONE,"load error visible before failure");f.tutorial().mainError();ok(message.getVisibility()==View.VISIBLE,"main-frame failure did not reveal recovery hint");});
  if(failed>0)System.exit(1);System.out.println("verify-android-tutorial-host: PASS ("+assertions+" assertions)");
 }
 static TextView findText(View v){if(v instanceof TextView)return(TextView)v;if(v instanceof ViewGroup)for(View x:((ViewGroup)v).children()){TextView t=findText(x);if(t!=null)return t;}return null;}
}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-tutorial-host-') as tmp:
    temp = Path(tmp)
    sources = []
    for relative, content in stubs.items():
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8', newline='\n')
        sources.append(str(target))
    snapshot = temp / 'cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java'
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_bytes(source)
    sources.append(str(snapshot))
    classes = temp / 'classes'
    classes.mkdir()
    try:
        compiled = subprocess.run([str(javac), '-encoding', 'UTF-8', '-d', str(classes), *sources], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except FileNotFoundError:
        raise SystemExit('Java compiler (javac) is required; install a JDK or pass --java-bin')
    if compiled.returncode:
        raise SystemExit(compiled.stdout + compiled.stderr)
    try:
        result = subprocess.run([str(java), '-cp', str(classes), 'TutorialHostProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except FileNotFoundError:
        raise SystemExit('Java runtime (java) is required; install a JDK or pass --java-bin')
    if plugin.read_bytes() != source:
        raise SystemExit('LifelineTutorialHostPlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    print(result.stdout.strip())
    print('source_sha256=' + source_hash)
