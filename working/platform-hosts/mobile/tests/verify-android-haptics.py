"""Compile and exercise the real Android haptics plugin with host-side stubs.

This checks the Java plugin's dispatch and lifecycle contract on a desktop JDK.
It does not build an Android APK or provide device haptics evidence.
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
plugin = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineHapticsPlugin.java'
source = plugin.read_bytes()
digest = hashlib.sha256(source).hexdigest().upper()
suffix = '.exe' if sys.platform == 'win32' else ''
java_bin = args.java_bin.resolve() if args.java_bin else None
javac = java_bin / ('javac' + suffix) if java_bin else Path('javac' + suffix)
java = java_bin / ('java' + suffix) if java_bin else Path('java' + suffix)

stubs = {
    'android/view/HapticFeedbackConstants.java': '''package android.view; public final class HapticFeedbackConstants { public static final int VIRTUAL_KEY=17; }''',
    'android/view/View.java': '''package android.view; public class View { public static final int VIRTUAL_KEY=17; }''',
    'android/webkit/RenderProcessGoneDetail.java': '''package android.webkit; public class RenderProcessGoneDetail {}''',
    'android/webkit/WebView.java': '''package android.webkit;
public class WebView { public boolean attached=true,shown=true,focused=true,enabled=true,hapticResult=true; public int effect=-1,calls;
 public boolean isAttachedToWindow(){return attached;} public boolean isShown(){return shown;} public boolean hasWindowFocus(){return focused;} public boolean isEnabled(){return enabled;}
 public boolean performHapticFeedback(int value){effect=value;calls++;return hapticResult;}
}''',
    'android/os/SystemClock.java': '''package android.os; public final class SystemClock { public static long now; public static long uptimeMillis(){return now;} }''',
    'android/app/Activity.java': '''package android.app;
public class Activity { public boolean finishing,destroyed,throwOnPost; public final java.util.List<Runnable> queue=new java.util.ArrayList<>();
 public void runOnUiThread(Runnable r){if(throwOnPost)throw new RuntimeException("post failed");queue.add(r);} public boolean isFinishing(){return finishing;} public boolean isDestroyed(){return destroyed;}
 public void drain(){while(!queue.isEmpty())queue.remove(0).run();}
}''',
    'com/getcapacitor/JSObject.java': '''package com.getcapacitor; public class JSObject { private final java.util.Map<String,Object> values=new java.util.LinkedHashMap<>(); public JSObject put(String k,Object v){values.put(k,v);return this;} public Object get(String k){return values.get(k);} }''',
    'com/getcapacitor/PluginCall.java': '''package com.getcapacitor; public class PluginCall { public JSObject result; public int resolves; public void resolve(JSObject r){result=r;resolves++;} }''',
    'com/getcapacitor/PluginMethod.java': '''package com.getcapacitor; public @interface PluginMethod {}''',
    'com/getcapacitor/annotation/CapacitorPlugin.java': '''package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}''',
    'com/getcapacitor/WebViewListener.java': '''package com.getcapacitor; import android.webkit.*; public class WebViewListener { public void onPageStarted(WebView w){} public void onPageLoaded(WebView w){} public boolean onRenderProcessGone(WebView w,RenderProcessGoneDetail d){return false;} }''',
    'com/getcapacitor/Bridge.java': '''package com.getcapacitor; import android.webkit.WebView; public class Bridge { public WebView web=new WebView(); public int added,removed; public void addWebViewListener(WebViewListener l){added++;} public void removeWebViewListener(WebViewListener l){removed++;} public WebView getWebView(){return web;} }''',
    'com/getcapacitor/Plugin.java': '''package com.getcapacitor; import android.app.Activity; public class Plugin { private final Bridge bridge=new Bridge(); private final Activity activity=new Activity(); public Bridge getBridge(){return bridge;} public Activity getActivity(){return activity;} public void load(){} public void handleOnPause(){} public void handleOnResume(){} public void handleOnDestroy(){} }''',
    'HapticsProbe.java': r'''import android.os.SystemClock; import android.webkit.*; import android.view.HapticFeedbackConstants; import com.getcapacitor.*; import cn.lifelinegame.mobile.LifelineHapticsPlugin;
public final class HapticsProbe {
 static int checks; static void ok(boolean v,String m){checks++;if(!v)throw new AssertionError(m);} static void status(PluginCall c,String s){ok(c.result!=null,"call unresolved");ok(s.equals(c.result.get("status")),"expected status "+s+" got "+c.result.get("status"));}
 static final class F { final LifelineHapticsPlugin p=new LifelineHapticsPlugin(); final Bridge b=p.getBridge(); final android.app.Activity a=p.getActivity(); F(){SystemClock.now=1000;p.load();} void ready(){WebViewListener l=b.added==0?null:null; try {java.lang.reflect.Field f=LifelineHapticsPlugin.class.getDeclaredField("webViewListener");f.setAccessible(true);((WebViewListener)f.get(p)).onPageLoaded(b.web);}catch(Exception e){throw new RuntimeException(e);}} void start(){try{java.lang.reflect.Field f=LifelineHapticsPlugin.class.getDeclaredField("webViewListener");f.setAccessible(true);((WebViewListener)f.get(p)).onPageStarted(b.web);}catch(Exception e){throw new RuntimeException(e);}} PluginCall call(){PluginCall c=new PluginCall();p.requestMoveHaptic(c);return c;} }
 public static void main(String[] args){
  {F f=new F();PluginCall c=f.call();status(c,"suppressed");ok(f.a.queue.isEmpty()&&f.b.web.calls==0,"not-ready request dispatched");}
  {F f=new F();f.ready();PluginCall c=f.call();ok(c.result==null&&f.a.queue.size()==1,"ready request not queued");f.a.drain();status(c,"requested");ok(f.b.web.calls==1&&f.b.web.effect==HapticFeedbackConstants.VIRTUAL_KEY,"effect mapping changed");}
  {F f=new F();f.ready();f.p.handleOnPause();status(f.call(),"suppressed");ok(f.a.queue.isEmpty(),"background request queued");f.p.handleOnResume();PluginCall c=f.call();f.a.drain();status(c,"requested");}
  {F f=new F();f.ready();PluginCall c=f.call();f.p.handleOnDestroy();f.a.drain();status(c,"suppressed");ok(f.b.web.calls==0&&f.b.removed==1,"destroy failed to suppress/release");status(f.call(),"suppressed");}
  {for(String gate:new String[]{"attached","shown","focused","enabled"}){F f=new F();f.ready();PluginCall c=f.call();try{WebView.class.getField(gate).setBoolean(f.b.web,false);}catch(Exception e){throw new RuntimeException(e);}f.a.drain();status(c,"suppressed");ok(f.b.web.calls==0,"view gate ignored: "+gate);}}
  {F f=new F();f.ready();PluginCall c=f.call();SystemClock.now+=351;f.a.drain();status(c,"suppressed");ok(f.b.web.calls==0,"stale dispatch performed haptic");}
  {F f=new F();f.ready();PluginCall old=f.call();status(f.call(),"suppressed");ok(f.a.queue.size()==1,"concurrent request queued");f.a.drain();status(old,"requested");PluginCall next=f.call();f.a.drain();status(next,"requested");ok(f.b.web.calls==2,"in-flight state did not recover");}
  {F f=new F();f.ready();PluginCall stale=f.call();f.start();f.ready();f.a.drain();status(stale,"suppressed");ok(f.b.web.calls==0,"old page generation dispatched");}
  {F f=new F();f.ready();PluginCall stale=f.call();f.p.handleOnPause();f.p.handleOnResume();f.a.drain();status(stale,"suppressed");ok(f.b.web.calls==0,"pause/resume accepted old generation");}
  {F f=new F();f.ready();f.a.throwOnPost=true;PluginCall c=f.call();status(c,"suppressed");ok(f.a.queue.isEmpty(),"failed post queued work");f.a.throwOnPost=false;PluginCall retry=f.call();f.a.drain();status(retry,"requested");}
  {F f=new F();f.ready();f.b.web.hapticResult=false;PluginCall c=f.call();f.a.drain();status(c,"suppressed");ok(f.b.web.calls==1,"false platform result not observed");}
  System.out.println("verify-android-haptics: PASS ("+checks+" assertions)");
 }
}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-haptics-') as tmp:
    temp = Path(tmp)
    sources = []
    for relative, content in stubs.items():
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        sources.append(str(target))
    snapshot = temp / 'cn/lifelinegame/mobile/LifelineHapticsPlugin.java'
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
        result = subprocess.run([str(java), '-cp', str(classes), 'HapticsProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except FileNotFoundError:
        raise SystemExit('Java runtime (java) is required; install a JDK or pass --java-bin')
    if plugin.read_bytes() != source:
        raise SystemExit('LifelineHapticsPlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    print(result.stdout.strip())
    print('source_sha256=' + digest)
