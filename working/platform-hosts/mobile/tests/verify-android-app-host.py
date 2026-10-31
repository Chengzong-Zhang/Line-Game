"""Compile and exercise the real Capacitor App plugin with host-side stubs.

This checks selected plugin API and lifecycle behavior on a desktop JDK. It is
not an Android SDK build or device acceptance test.
"""
from pathlib import Path
import argparse
import hashlib
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
plugin = root / 'mobile/node_modules/@capacitor/app/android/src/main/java/com/capacitorjs/plugins/app/AppPlugin.java'
source = plugin.read_bytes()
digest = hashlib.sha256(source).hexdigest().upper()
suffix = '.exe' if sys.platform == 'win32' else ''
java_bin = args.java_bin.resolve()
javac = java_bin / ('javac' + suffix)
java = java_bin / ('java' + suffix)

stubs = {
    'android/content/Intent.java': '''package android.content; import android.net.Uri; public class Intent {public static final String ACTION_VIEW="android.intent.action.VIEW"; private String action; private Uri data; public Intent(String a,Uri d){action=a;data=d;} public String getAction(){return action;} public Uri getData(){return data;}}''',
    'android/content/pm/ApplicationInfo.java': '''package android.content.pm; public class ApplicationInfo {public int labelRes; public CharSequence nonLocalizedLabel="Host App";}''',
    'android/content/pm/PackageInfo.java': '''package android.content.pm; public class PackageInfo {public String packageName="cn.lifelinegame.mobile",versionName="1.2.3"; public long versionCode=7;}''',
    'android/content/pm/PackageManager.java': '''package android.content.pm; public class PackageManager {}''',
    'android/net/Uri.java': '''package android.net; public class Uri {private final String value; private Uri(String v){value=v;} public static Uri parse(String v){return new Uri(v);} public String toString(){return value;}}''',
    'androidx/activity/OnBackPressedCallback.java': '''package androidx.activity; public abstract class OnBackPressedCallback {private boolean enabled; public OnBackPressedCallback(boolean e){enabled=e;} public void setEnabled(boolean e){enabled=e;} public boolean isEnabled(){return enabled;} public abstract void handleOnBackPressed();}''',
    'androidx/activity/OnBackPressedDispatcher.java': '''package androidx.activity; import android.app.Activity; public class OnBackPressedDispatcher {public OnBackPressedCallback callback; public void addCallback(Activity a,OnBackPressedCallback c){callback=c;} public void dispatch(){if(callback!=null&&callback.isEnabled())callback.handleOnBackPressed();}}''',
    'android/app/Activity.java': '''package android.app; import androidx.activity.OnBackPressedDispatcher; public class Activity {private final OnBackPressedDispatcher dispatcher=new OnBackPressedDispatcher(); public int finishes,moves; public OnBackPressedDispatcher getOnBackPressedDispatcher(){return dispatcher;} public void finish(){finishes++;} public void moveTaskToBack(boolean v){if(v)moves++;}}''',
    'androidx/appcompat/app/AppCompatDelegate.java': '''package androidx.appcompat.app; import androidx.core.os.LocaleListCompat; public class AppCompatDelegate {public static LocaleListCompat getApplicationLocales(){return new LocaleListCompat();}}''',
    'androidx/core/os/LocaleListCompat.java': '''package androidx.core.os; import java.util.Locale; public class LocaleListCompat {public boolean isEmpty(){return true;} public Locale get(int i){return null;}}''',
    'androidx/core/content/pm/PackageInfoCompat.java': '''package androidx.core.content.pm; import android.content.pm.PackageInfo; public class PackageInfoCompat {public static long getLongVersionCode(PackageInfo p){return p.versionCode;}}''',
    'com/getcapacitor/JSObject.java': '''package com.getcapacitor; import java.util.*; public class JSObject {private final Map<String,Object> values=new LinkedHashMap<>(); public JSObject put(String k,Object v){values.put(k,v);return this;} public Object get(String k){return values.get(k);} public boolean has(String k){return values.containsKey(k);}}''',
    'com/getcapacitor/Logger.java': '''package com.getcapacitor; public class Logger {public static void debug(String tag,String message){}}''',
    'com/getcapacitor/PluginCall.java': '''package com.getcapacitor; public class PluginCall {public JSObject result; public String error; public boolean resolved; private Boolean enabled; public PluginCall(){} public PluginCall(Boolean e){enabled=e;} public Boolean getBoolean(String key){return enabled;} public void resolve(JSObject o){result=o;resolved=true;} public void resolve(){resolve(new JSObject());} public void reject(String m){error=m;}}''',
    'com/getcapacitor/PluginMethod.java': '''package com.getcapacitor; public @interface PluginMethod {}''',
    'com/getcapacitor/annotation/CapacitorPlugin.java': '''package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}''',
    'com/getcapacitor/util/InternalUtils.java': '''package com.getcapacitor.util; import android.content.pm.*; public class InternalUtils {public static boolean fail; public static PackageInfo getPackageInfo(PackageManager p,String n){if(fail)throw new RuntimeException();return new PackageInfo();}}''',
    'android/webkit/WebView.java': '''package android.webkit; public class WebView {public boolean canGoBack; public int backCalls; public boolean canGoBack(){return canGoBack;} public void goBack(){backCalls++;}}''',
    'com/getcapacitor/CapacitorApp.java': '''package com.getcapacitor; import java.util.function.Consumer; public class CapacitorApp {private Consumer<Boolean> status; private Consumer<RestoredResult> restored; public boolean active=true; public void setStatusChangeListener(Consumer<Boolean> c){status=c;} public void setAppRestoredListener(Consumer<RestoredResult> c){restored=c;} public void status(boolean b){if(status!=null)status.accept(b);} public boolean isActive(){return active;} public boolean cleared(){return status==null&&restored==null;}}''',
    'com/getcapacitor/RestoredResult.java': '''package com.getcapacitor; public class RestoredResult {public JSObject getWrappedResult(){return new JSObject().put("ok",true);}}''',
    'com/getcapacitor/Bridge.java': '''package com.getcapacitor; import android.app.Activity; import android.net.Uri; import android.webkit.WebView; public class Bridge {private final CapacitorApp app=new CapacitorApp(); private final WebView web=new WebView(); private final Activity activity=new Activity(); public CapacitorApp getApp(){return app;} public WebView getWebView(){return web;} public Activity getActivity(){return activity;} public Uri getIntentUri(){return null;} public int jsEvents; public void triggerJSEvent(String n,String t){if("backbutton".equals(n)&&"document".equals(t))jsEvents++;}}''',
    'com/getcapacitor/PluginConfig.java': '''package com.getcapacitor; public class PluginConfig {public boolean getBoolean(String key,boolean fallback){return fallback;}}''',
    'com/getcapacitor/PluginContext.java': '''package com.getcapacitor; import android.content.pm.*; public class PluginContext {public PackageManager getPackageManager(){return new PackageManager();} public String getPackageName(){return "cn.lifelinegame.mobile";} public ApplicationInfo getApplicationInfo(){return new ApplicationInfo();} public String getString(int id){return "Localized App";}}''',
    'com/getcapacitor/Plugin.java': '''package com.getcapacitor; import android.app.Activity; import android.content.Intent; public class Plugin {protected final Bridge bridge=new Bridge(); private final Activity activity=new Activity(); private final PluginContext context=new PluginContext(); private final PluginConfig config=new PluginConfig(); public java.util.List<String> names=new java.util.ArrayList<>(); public java.util.List<JSObject> events=new java.util.ArrayList<>(); public java.util.List<Boolean> retain=new java.util.ArrayList<>(); public java.util.Set<String> listeners=new java.util.HashSet<>(); public Bridge getBridge(){return bridge;} public Activity getActivity(){return activity;} public PluginContext getContext(){return context;} public PluginConfig getConfig(){return config;} protected String getLogTag(){return "App";} protected void handleOnNewIntent(Intent i){} protected void handleOnPause(){} protected void handleOnResume(){} protected void handleOnDestroy(){} protected boolean hasListeners(String n){return listeners.contains(n);} protected void notifyListeners(String n,JSObject d){notifyListeners(n,d,false);} protected void notifyListeners(String n,JSObject d,boolean r){names.add(n);events.add(d);retain.add(r);} }''',
    'com/capacitorjs/plugins/app/AppPluginProbe.java': r'''package com.capacitorjs.plugins.app; import androidx.activity.OnBackPressedDispatcher; import com.getcapacitor.*;
public final class AppPluginProbe {
 static int checks; static void invoke(AppPlugin p,String n){try{java.lang.reflect.Method m=AppPlugin.class.getDeclaredMethod(n);m.setAccessible(true);m.invoke(p);}catch(Exception e){throw new RuntimeException(e);}} static void ok(boolean b,String m){checks++;if(!b)throw new AssertionError(m);} static int count(AppPlugin p,String n){return (int)p.names.stream().filter(n::equals).count();} static JSObject last(AppPlugin p,String n){for(int i=p.names.size()-1;i>=0;i--)if(n.equals(p.names.get(i)))return p.events.get(i);return null;}
 static final class F {final AppPlugin p=new AppPlugin(); final Bridge b=p.getBridge(); final OnBackPressedDispatcher d=p.getActivity().getOnBackPressedDispatcher(); F(){p.load();} void back(){d.dispatch();}}
 public static void main(String[] args){
  {F f=new F();PluginCall c=new PluginCall();f.p.getInfo(c);ok(c.resolved&&c.error==null,"getInfo did not resolve");ok("Host App".equals(c.result.get("name")),"app label changed");ok("cn.lifelinegame.mobile".equals(c.result.get("id")),"package id changed");ok("7".equals(c.result.get("build")),"build code conversion changed");ok("1.2.3".equals(c.result.get("version")),"version name changed");}
  {F f=new F();PluginCall c=new PluginCall();f.p.getState(c);ok(Boolean.TRUE.equals(c.result.get("isActive")),"getState must report bridge activity");f.b.getApp().active=false;PluginCall inactive=new PluginCall();f.p.getState(inactive);ok(Boolean.FALSE.equals(inactive.result.get("isActive")),"getState did not reflect inactive bridge");}
  {F f=new F();f.b.getApp().status(false);f.b.getApp().status(true);ok(count(f.p,"appStateChange")==2,"status listener did not forward both transitions");JSObject first=f.p.events.get(f.p.names.indexOf("appStateChange"));ok(Boolean.FALSE.equals(first.get("isActive")),"inactive status payload changed");ok(Boolean.TRUE.equals(last(f.p,"appStateChange").get("isActive")),"active status payload changed");ok(!f.p.retain.get(0),"state change retention behavior changed");}
  {F f=new F();invoke(f.p,"handleOnResume");ok(count(f.p,"resume")==0,"first resume must not emit resume event");invoke(f.p,"handleOnPause");ok(count(f.p,"pause")==1,"pause event missing");invoke(f.p,"handleOnResume");ok(count(f.p,"resume")==1,"resume-after-pause event missing");}
  {F f=new F();f.b.getWebView().canGoBack=true;f.back();ok(f.b.getWebView().backCalls==1,"unhandled back did not navigate WebView");f.b.getWebView().canGoBack=false;f.back();ok(f.b.getWebView().backCalls==1,"unhandled back navigated without history");}
  {F f=new F();f.p.listeners.add("backButton");f.b.getWebView().canGoBack=true;f.back();ok(f.b.getWebView().backCalls==0,"JS back listener should own navigation");ok(count(f.p,"backButton")==1,"backButton event missing");ok(Boolean.TRUE.equals(last(f.p,"backButton").get("canGoBack")),"backButton canGoBack payload changed");ok(f.b.jsEvents==1,"legacy backbutton JS event missing");ok(f.p.retain.get(f.p.retain.size()-1),"backButton event retention changed");}
  {F f=new F();int before=f.p.getActivity().moves;PluginCall c=new PluginCall();f.p.minimizeApp(c);ok(c.resolved,"minimizeApp call did not resolve");ok(f.p.getActivity().moves==before+1,"minimizeApp must move the Activity to background exactly once");}
  {F f=new F();invoke(f.p,"handleOnDestroy");ok(f.b.getApp().cleared(),"destroy did not unregister app listeners");}
  System.out.println("verify-android-app-host: PASS ("+checks+" assertions)");
 }
}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-app-host-') as tmp:
    temp = Path(tmp)
    sources = []
    for relative, content in stubs.items():
        target = temp / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        sources.append(str(target))
    snapshot = temp / 'com/capacitorjs/plugins/app/AppPlugin.java'
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_bytes(source)
    sources.append(str(snapshot))
    classes = temp / 'classes'
    classes.mkdir()
    try:
        compiled = subprocess.run([str(javac), '-encoding', 'UTF-8', '-d', str(classes), *sources], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except FileNotFoundError:
        raise SystemExit('Java compiler (javac) is required; pass --java-bin to a JDK bin directory')
    if compiled.returncode:
        raise SystemExit(compiled.stdout + compiled.stderr)
    try:
        result = subprocess.run([str(java), '-cp', str(classes), 'com.capacitorjs.plugins.app.AppPluginProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except FileNotFoundError:
        raise SystemExit('Java runtime (java) is required; pass --java-bin to a JDK bin directory')
    if plugin.read_bytes() != source:
        raise SystemExit('AppPlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    expected_output = 'verify-android-app-host: PASS (24 assertions)'
    if result.stdout.strip() != expected_output:
        raise SystemExit(f'Java probe output mismatch: expected {expected_output!r}, got {result.stdout.strip()!r}')
    print(expected_output)
    print('source_sha256=' + digest)
