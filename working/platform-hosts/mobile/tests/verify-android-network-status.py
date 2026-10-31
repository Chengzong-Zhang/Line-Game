"""Compile and exercise the current Android network plugin with minimal host stubs.

This verifies Java behavior against the source in this checkout. It does not
compile against the Android SDK or prove behavior on an Android device.
Run with --java-bin pointing to a JDK bin directory.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--java-bin', type=Path, required=True)
parser.add_argument('--plugin-source', type=Path, help=argparse.SUPPRESS)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
tracked_plugin = root / 'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineNetworkPlugin.java'
plugin = args.plugin_source or tracked_plugin
tracked_source_bytes = tracked_plugin.read_bytes()
source_bytes = plugin.read_bytes()

stubs = {
    'android/content/Context.java': '''package android.content;
public class Context { public static final String CONNECTIVITY_SERVICE="connectivity"; public Object service; public Object getSystemService(String name){return service;} }''',
    'android/net/Network.java': '''package android.net;
public final class Network { public final int id; public Network(int id){this.id=id;} public boolean equals(Object x){return x instanceof Network && ((Network)x).id==id;} public int hashCode(){return id;} }''',
    'android/net/NetworkCapabilities.java': '''package android.net;
public class NetworkCapabilities { public static final int NET_CAPABILITY_VALIDATED=16; private final boolean validated; public NetworkCapabilities(boolean v){validated=v;} public boolean hasCapability(int c){return c==NET_CAPABILITY_VALIDATED && validated;} }''',
    'android/net/ConnectivityManager.java': '''package android.net;
import java.util.*;
public class ConnectivityManager {
 public Network active=new Network(1); public NetworkCapabilities caps=new NetworkCapabilities(true);
 public int registers, unregisters, queries, capQueries; public boolean failRegister, failUnregister, failQuery;
 public final List<NetworkCallback> callbacks=new ArrayList<>(); public final Set<NetworkCallback> live=new HashSet<>();
 public Network getActiveNetwork(){queries++;if(failQuery)throw new IllegalStateException("secret-native-error");return active;}
 public NetworkCapabilities getNetworkCapabilities(Network n){capQueries++;return caps;}
 public void registerDefaultNetworkCallback(NetworkCallback c){registers++;callbacks.add(c);live.add(c);if(failRegister)throw new IllegalStateException("secret-native-error");}
 public void unregisterNetworkCallback(NetworkCallback c){unregisters++;if(failUnregister)throw new IllegalStateException("secret-native-error");live.remove(c);}
 public static class NetworkCallback {public void onAvailable(Network n){} public void onCapabilitiesChanged(Network n,NetworkCapabilities c){} public void onLost(Network n){} public void onUnavailable(){}}
}''',
    'android/webkit/WebView.java': 'package android.webkit; public class WebView {}',
    'android/webkit/RenderProcessGoneDetail.java': 'package android.webkit; public class RenderProcessGoneDetail {}',
    'com/getcapacitor/JSObject.java': '''package com.getcapacitor;
import java.util.*;
public class JSObject {private final Map<String,Object> values=new LinkedHashMap<>(); public JSObject put(String k,Object v){values.put(k,v);return this;} public Object get(String k){return values.get(k);} public boolean has(String k){return values.containsKey(k);} }''',
    'com/getcapacitor/PluginCall.java': '''package com.getcapacitor;
public class PluginCall {private final String token; public JSObject result; public String error; public boolean resolved; public PluginCall(String token){this.token=token;} public String getString(String key,String fallback){return "subscriptionId".equals(key)&&token!=null?token:fallback;} public void resolve(JSObject value){resolved=true;result=value;} public void resolve(){resolve(new JSObject());} public void reject(String message){error=message;} }''',
    'com/getcapacitor/WebViewListener.java': '''package com.getcapacitor;
import android.webkit.*;
public class WebViewListener {public void onPageStarted(WebView view){} public void onPageLoaded(WebView view){} public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){return false;} }''',
    'com/getcapacitor/Bridge.java': '''package com.getcapacitor;
import java.util.*;
public class Bridge {public final List<WebViewListener> listeners=new ArrayList<>(); public void addWebViewListener(WebViewListener v){listeners.add(v);} public void removeWebViewListener(WebViewListener v){listeners.remove(v);} }''',
    'com/getcapacitor/Plugin.java': '''package com.getcapacitor;
import android.content.Context;
public class Plugin {public final Context context=new Context(); public final Bridge bridge=new Bridge(); public final java.util.List<JSObject> events=new java.util.ArrayList<>(); public final java.util.List<String> eventNames=new java.util.ArrayList<>(); public Context getContext(){return context;} public Bridge getBridge(){return bridge;} public void load(){} public void handleOnDestroy(){} public void handleOnPause(){} public void handleOnResume(){} public void notifyListeners(String name,JSObject value){eventNames.add(name);events.add(value);} }''',
    'com/getcapacitor/PluginMethod.java': 'package com.getcapacitor; public @interface PluginMethod {}',
    'com/getcapacitor/annotation/CapacitorPlugin.java': 'package com.getcapacitor.annotation; public @interface CapacitorPlugin {String name();}',
    'NetworkProbe.java': r'''import android.net.*;import android.webkit.*;import com.getcapacitor.*;import cn.lifelinegame.mobile.LifelineNetworkPlugin;
public final class NetworkProbe {
 static final String A="aaaaaaaaaaaaaaaa.1",B="aaaaaaaaaaaaaaaa.2",C="bbbbbbbbbbbbbbbb.1"; static int failed=0;
 static void ok(boolean b,String m){if(!b)throw new AssertionError(m);}
 static int revision(JSObject s){return ((Number)s.get("revision")).intValue();}
 static void snapshot(JSObject s,String availability,String validation,int revision){ok(s!=null,"missing snapshot");ok(((Number)s.get("schemaVersion")).intValue()==1,"schemaVersion");ok("android-native".equals(s.get("source")),"source");ok(availability.equals(s.get("availability")),"availability");ok(validation.equals(s.get("validation")),"validation");ok(revision(s)==revision,"revision");}
 static final class F {final LifelineNetworkPlugin p=new LifelineNetworkPlugin(); final ConnectivityManager c=new ConnectivityManager(); F(){p.context.service=c;p.load();p.bridge.listeners.get(0).onPageLoaded(new WebView());} PluginCall start(String id){PluginCall r=new PluginCall(id);p.startNetworkStatus(r);return r;} PluginCall stop(String id){PluginCall r=new PluginCall(id);p.stopNetworkStatus(r);return r;} PluginCall get(){PluginCall r=new PluginCall(null);p.getNetworkStatus(r);return r;} JSObject latest(){return (JSObject)p.events.get(p.events.size()-1).get("status");} ConnectivityManager.NetworkCallback cb(){return c.callbacks.get(c.callbacks.size()-1);} void event(String owner){int n=p.events.size()-1;ok("networkStatusChange".equals(p.eventNames.get(n)),"event name");ok(owner.equals(p.events.get(n).get("subscriptionId")),"event subscriptionId="+p.events.get(n).get("subscriptionId"));} }
 static void test(String name,Runnable r){try{r.run();System.out.println("PASS\t"+name);}catch(Throwable e){failed++;System.out.println("FAIL\t"+name+"\t"+e);}}
 public static void main(String[] args){
 test("cold plugin has no network side effect",()->{F f=new F();ok(f.c.queries+f.c.registers==0,"startup query or registration");});
 test("one-shot status has exact schema and monotone revisions without registering",()->{F f=new F();PluginCall r=f.get();snapshot(r.result,"available","validated",1);f.c.caps=new NetworkCapabilities(false);r=f.get();snapshot(r.result,"available","unvalidated",2);f.c.active=null;r=f.get();snapshot(r.result,"unavailable","unknown",3);ok(f.c.registers==0,"registered query");});
 test("callbacks publish named events and handle availability transitions",()->{F f=new F();PluginCall r=f.start(A);snapshot(r.result,"available","validated",1);f.cb().onUnavailable();snapshot(f.latest(),"unavailable","unknown",2);f.event(A);f.cb().onAvailable(new Network(2));snapshot(f.latest(),"available","unknown",3);f.event(A);f.cb().onCapabilitiesChanged(new Network(2),new NetworkCapabilities(true));snapshot(f.latest(),"available","validated",4);f.event(A);int before=f.p.events.size();f.cb().onLost(new Network(2));ok(f.p.events.size()==before+1,"current default loss was not published");snapshot(f.latest(),"unavailable","unknown",5);f.event(A);before=f.p.events.size();f.cb().onCapabilitiesChanged(new Network(2),new NetworkCapabilities(false));ok(f.p.events.size()==before,"capabilities after loss were accepted");ok(revision(f.latest())==5,"stale capabilities advanced revision");});
 test("wrong-network loss and capability callbacks cannot replace current default",()->{F f=new F();f.start(A);f.cb().onAvailable(new Network(2));f.cb().onCapabilitiesChanged(new Network(2),new NetworkCapabilities(true));int n=f.p.events.size(),revision=revision(f.latest());f.cb().onLost(new Network(1));f.cb().onCapabilitiesChanged(new Network(1),new NetworkCapabilities(false));ok(f.p.events.size()==n,"accepted old default callbacks");ok(revision(f.latest())==revision,"wrong-network advanced revision");});
 test("subscription identifiers are validated and owners cannot stop replacements",()->{F f=new F();ok(f.start("").error!=null,"empty start accepted");ok(f.start(new String(new char[97]).replace('\0','x')).error!=null,"oversized start accepted");ok(f.c.registers==0,"invalid IDs registered");ok(f.start(A).resolved,"valid start rejected");ok(f.start(A).resolved&&f.c.registers==1,"same ID duplicated registration");ConnectivityManager.NetworkCallback stale=f.cb();ok(f.stop(C).resolved&&f.c.live.size()==1,"wrong owner stopped monitor");f.stop(A);ok(f.start(B).resolved,"replacement rejected");f.stop(A);ok(f.c.live.size()==1,"old owner stop killed replacement");int before=f.p.events.size();stale.onAvailable(new Network(5));ok(f.p.events.size()==before,"stale owner published event");f.cb().onAvailable(new Network(6));f.event(B);});
 test("cancellation invalidates callbacks and permanently rejects the old token",()->{F f=new F();f.start(A);ConnectivityManager.NetworkCallback cb=f.cb();f.stop(A);int n=f.p.events.size();cb.onAvailable(new Network(5));ok(f.p.events.size()==n,"late callback");ok(f.c.live.isEmpty(),"native monitor retained");ok(f.start(A).error!=null,"cancelled token restarted");});
 test("pause blocks queries and starts, then resume restores monitoring",()->{F f=new F();f.start(A);f.p.handleOnPause();int n=f.c.queries;PluginCall start=f.start(B),query=f.get();ok(start.error!=null,"background start");snapshot(query.result,"unknown","unknown",1);ok("background".equals(query.result.get("reason")),"background reason");ok(f.c.queries==n,"background OS query");f.p.handleOnResume();ok(f.start(B).resolved,"resume start");ok(f.c.live.size()==1,"resume duplicate");});
 test("page replacement tears down old page and subscription ownership",()->{F f=new F();f.start(A);ConnectivityManager.NetworkCallback cb=f.cb();f.p.bridge.listeners.get(0).onPageStarted(new WebView());int n=f.p.events.size();cb.onAvailable(new Network(5));ok(f.p.events.size()==n,"old page event");ok(f.c.live.isEmpty(),"page teardown leaked");f.p.bridge.listeners.get(0).onPageLoaded(new WebView());ok(f.start(A).error!=null,"old page token restarted");ok(f.start(C).resolved,"new page cannot register");});
 test("unregister failure pins resource and invalidates callbacks",()->{F f=new F();f.start(A);ConnectivityManager.NetworkCallback cb=f.cb();f.c.failUnregister=true;ok(f.stop(A).error!=null,"cleanup falsely succeeded");int n=f.p.events.size();cb.onAvailable(new Network(9));ok(f.p.events.size()==n,"failed cleanup callback accepted");ok(f.start(B).error!=null,"new registration after cleanup failure");ok(f.c.registers==1,"duplicate OS registration");});
 test("registration failure cleans up safely and failed cleanup blocks retry",()->{F clean=new F();clean.c.failRegister=true;PluginCall failedStart=clean.start(A);ok(failedStart.error!=null&&!failedStart.error.contains("secret-native-error"),"registration error leaked or was hidden");ok(clean.c.live.isEmpty(),"failed registration leaked callback");clean.c.failRegister=false;ok(clean.start(B).resolved&&clean.c.registers==2,"clean retry failed");F blocked=new F();blocked.c.failRegister=true;blocked.c.failUnregister=true;ok(blocked.start(A).error!=null,"failure hidden");ok(blocked.start(B).error!=null,"cleanup bypassed");ok(blocked.c.registers==1,"registration accumulated");});
 test("missing service and native errors preserve precise unknown/error contracts",()->{F f=new F();f.p.context.service=null;PluginCall r=f.get();snapshot(r.result,"unknown","unknown",0);ok("unavailable".equals(r.result.get("reason")),"missing-service reason");ok(r.error==null,"missing service rejected");F g=new F();g.c.failQuery=true;r=g.get();ok(r.error!=null&&!r.error.contains("secret-native-error"),"native error exposed or hidden");});
 test("render loss and destroy isolate stale callbacks and release listeners",()->{F render=new F();render.start(A);ConnectivityManager.NetworkCallback old=render.cb();WebViewListener listener=render.p.bridge.listeners.get(0);ok(!listener.onRenderProcessGone(new WebView(),new RenderProcessGoneDetail()),"render loss return changed");ok(render.c.live.isEmpty(),"render loss leaked callback");int n=render.p.events.size();old.onAvailable(new Network(8));ok(render.p.events.size()==n,"render-loss stale event");ok(render.start(B).error!=null,"render-loss page remained ready");F destroyed=new F();destroyed.start(A);old=destroyed.cb();destroyed.p.handleOnDestroy();ok(destroyed.c.live.isEmpty(),"destroy leaked monitor");ok(destroyed.p.bridge.listeners.isEmpty(),"destroy retained hook");n=destroyed.p.events.size();old.onAvailable(new Network(7));ok(destroyed.p.events.size()==n,"destroy stale event");});
 if(failed>0)System.exit(1);
 }}''',
}

with tempfile.TemporaryDirectory(prefix='lifeline-android-network-') as tmp:
    temp = Path(tmp)
    sources = []
    for rel, content in stubs.items():
        target = temp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        sources.append(str(target))
    plugin_snapshot = temp / 'cn/lifelinegame/mobile/LifelineNetworkPlugin.java'
    plugin_snapshot.parent.mkdir(parents=True, exist_ok=True)
    plugin_snapshot.write_bytes(source_bytes)
    sources.append(str(plugin_snapshot))
    classes = temp / 'classes'
    classes.mkdir()
    suffix = '.exe' if sys.platform == 'win32' else ''
    javac = args.java_bin / ('javac' + suffix)
    java = args.java_bin / ('java' + suffix)
    try:
        compile_result = subprocess.run([str(javac), '-encoding', 'UTF-8', '-d', str(classes), *sources], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
        if compile_result.returncode:
            raise SystemExit(compile_result.stdout + compile_result.stderr)
        result = subprocess.run([str(java), '-cp', str(classes), 'NetworkProbe'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    finally:
        if plugin.read_bytes() != source_bytes or tracked_plugin.read_bytes() != tracked_source_bytes:
            raise SystemExit('LifelineNetworkPlugin.java changed while the verifier ran')
    if result.returncode:
        raise SystemExit(result.stdout + result.stderr)
    checks = [line for line in result.stdout.splitlines() if line.startswith(('PASS\t', 'FAIL\t'))]
    expected = [
        'cold plugin has no network side effect',
        'one-shot status has exact schema and monotone revisions without registering',
        'callbacks publish named events and handle availability transitions',
        'wrong-network loss and capability callbacks cannot replace current default',
        'subscription identifiers are validated and owners cannot stop replacements',
        'cancellation invalidates callbacks and permanently rejects the old token',
        'pause blocks queries and starts, then resume restores monitoring',
        'page replacement tears down old page and subscription ownership',
        'unregister failure pins resource and invalidates callbacks',
        'registration failure cleans up safely and failed cleanup blocks retry',
        'missing service and native errors preserve precise unknown/error contracts',
        'render loss and destroy isolate stale callbacks and release listeners',
    ]
    names = [line.split('\t', 1)[1].split('\t', 1)[0] for line in checks]
    if names != expected or len(set(names)) != len(expected) or any(not line.startswith('PASS\t') for line in checks):
        raise SystemExit(result.stdout + result.stderr)
    print(json.dumps({'status': 'PASS', 'source_sha256': hashlib.sha256(source_bytes).hexdigest().upper(), 'checks': len(checks), 'output': checks}, ensure_ascii=False))
